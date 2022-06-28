// Copyright 2019 - See NOTICE file for copyright holders.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { assert, should } from "chai";
should();
const truffleAssert = require('truffle-assertions');
import {
  AdjudicatorContract,
  AdjudicatorInstance,
  TrivialAppContract,
  AssetHolderETHContract,
  AssetHolderETHInstance,
} from "../../types/truffle-contracts";
import { DisputePhase, Channel, SignedChannel, Params, Allocation, SubAlloc, Transaction, State, Asset } from "./Channel";
import { ether, wei2eth, hash, getChainID } from "../lib/web3";
import { fundingID, advanceBlockTime, describeWithBlockRevert, itWithBlockRevert } from "../lib/test";
import BN from "bn.js";
import {randomHex} from "web3-utils";

const Adjudicator = artifacts.require<AdjudicatorContract>("Adjudicator");
const TrivialApp = artifacts.require<TrivialAppContract>("TrivialApp");
const AssetHolderETH = artifacts.require<AssetHolderETHContract>("AssetHolderETH");

const zeroAddress = "0x0000000000000000000000000000000000000000";
const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

contract("Adjudicator", async (accounts) => {
  let adj: AdjudicatorInstance;
  let ah: AssetHolderETHInstance;
  let app = "";
  let asset: Asset;
  let assetIndex = 0;
  const parts = [accounts[1], accounts[2]];
  const balance = [ether(10), ether(20)];
  const name = ["A", "B"];
  const timeout = 60;
  const nonce = "0xB0B0FACE";
  let params: Params;
  let channelID = "";
  const A = 0, B = 1;
  const dummySubAlloc = new SubAlloc(hash(0), [], [0, 1]);

  function initialDeposit(idx: number) {
    const bal = balance[idx];
    it(name[idx] + " deposits " + wei2eth(bal) + " eth on the asset holder", async () => {
      await depositWithAssertions(channelID, parts[idx], bal);
    });
  }

  // adjudicator calls to register, refute, concludeFinal
  function adjcall(method: any, tx: Transaction): Promise<Truffle.TransactionResponse> {
    return method(
      tx.params.serialize(),
      tx.state.serialize(),
      tx.sigs,
      { from: accounts[0] },
    );
  }

  function register(tx: Transaction): Promise<Truffle.TransactionResponse> {
    const ch = new SignedChannel(tx.params, tx.state, tx.sigs);
    return adj.register(
      ch.serialize(),
      [],
      { from: accounts[0] },
    );
  }

  async function registerChannel(channel: Channel, subChannels: Channel[] = []): Promise<Truffle.TransactionResponse> {
    return adj.register(
      (await channel.signed()).serialize(),
      await Promise.all(subChannels.map(async ch => (await ch.signed()).serialize())),
      { from: accounts[0], gas: 500_000 },
    );
  }

  async function registerWithAssertions(channel: Channel, subChannels: Channel[]) {
    let res = adj.register(
      (await channel.signed()).serialize(),
      await Promise.all(subChannels.map(async ch => (await ch.signed()).serialize())),
      {from: accounts[0]}
    );
    await assertRegister(res, channel);
  }

  function progress(ch: Channel, oldState: any, actorIdx: number, sig: string): Promise<Truffle.TransactionResponse> {
    return adj.progress(
      ch.params.serialize(),
      oldState,
      ch.state.serialize(),
      actorIdx,
      sig,
      { from: accounts[0] },
    );
  }

  function concludeFinal(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adjcall(adj.concludeFinal, tx);
  }

  function conclude(tx: Transaction): Promise<Truffle.TransactionResponse> {
    return adj.conclude(tx.params.serialize(), tx.state.serialize(), [], { from: accounts[0] });
  }

  function concludeWithSubchannels(ledgerChannel: Channel, subchannels: Channel[]): Promise<Truffle.TransactionResponse> {
    return adj.conclude(
      ledgerChannel.params.serialize(),
      ledgerChannel.state.serialize(),
      subchannels.map(subchannel => subchannel.state.serialize()),
      {from: accounts[0], gas: 500_000}
    );
  }

  function assertEventEmitted(
    name: string, res: Truffle.TransactionResponse, channel: Channel, phase: DisputePhase) {
    truffleAssert.eventEmitted(res, name,
      (ev: any) => {
        return ev.channelID == channel.params.channelID()
          && ev.version == channel.state.version
          && ev.phase == phase;
      }
    );
  }

  async function assertDisputePhase(channelID: string, phase: DisputePhase) {
    const dispute = await adj.disputes.call(channelID)
    const disputePhaseIndex = 4
    assert(dispute[disputePhaseIndex].eqn(phase), "wrong channel phase")
  }

  async function assertRegister(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('ChannelUpdate', await res, channel, DisputePhase.DISPUTE);
    await assertDisputePhase(channel.state.channelID, DisputePhase.DISPUTE);
  }

  async function assertProgress(res: Promise<Truffle.TransactionResponse>, channel: Channel) {
    assertEventEmitted('ChannelUpdate', await res, channel, DisputePhase.FORCEEXEC);
    await assertDisputePhase(channel.state.channelID, DisputePhase.FORCEEXEC);
  }

  async function assertConclude(res: Promise<Truffle.TransactionResponse>, channel: Channel, subchannels: Channel[], checkOutcome: boolean = true) {
    /* this method currently only checks for the concluded and stored event of
    the ledger channel as it is not generally known which subchannels are not
    yet concluded. thus it is unclear for which subset of `subchannels` the
    events should be emitted. */
    assertEventEmitted('ChannelUpdate', await res, channel, DisputePhase.CONCLUDED);

    await assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED);
    await Promise.all(subchannels.map(async channel => assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED)));

    if (checkOutcome) {
      const expectedOutcome = accumulatedOutcome(channel, subchannels);
      await Promise.all(channel.params.participants.map(async (user, userIndex) => {
        let outcome = await ah.holdings.call(fundingID(channel.state.channelID, user));
        assert(outcome.eq(expectedOutcome[userIndex]), `outcome for user ${userIndex} not equal: got ${expectedOutcome[userIndex]}, expected ${outcome}`);
      }))
    }
  }

  async function assertConcludeFinal(res: Promise<Truffle.TransactionResponse>, channel: Channel, checkOutcome: boolean = true) {
    await assertConclude(res, channel, [], checkOutcome);
  }

  async function depositWithAssertions(channelID: string, user: string, amount: BN) {
    const fid = fundingID(channelID, user);
    truffleAssert.eventEmitted(
      await ah.deposit(fid, amount, { value: amount, from: user }),
      'Deposited',
      (ev: any) => { return ev.fundingID == fid && amount.eq(ev.amount); },
    );
  }

  function accumulatedOutcome(ledgerChannel: Channel, subchannels: Channel[]): BN[] {
    return ledgerChannel.params.participants.map((_, userIndex) => {
      let amount = new BN(ledgerChannel.state.outcome.balances[assetIndex][userIndex]);
      return amount.add(subchannels.reduce((acc, channel) => acc.add(new BN(channel.state.outcome.balances[assetIndex][userIndex])), new BN('0')));
    });
  }

  describe("setup", () => {
    it("account[0] deploys the Adjudicator contract", async () => {
      adj = await Adjudicator.new();
      let appInstance = await TrivialApp.new();
      app = appInstance.address;
      ah = await AssetHolderETH.new(adj.address);
      const chainID = await getChainID();
      asset = new Asset(chainID, ah.address);

      // app deployed, we can calculate the default parameters and channel id
      params = new Params(app, timeout, nonce, [parts[A], parts[B]], true);
      channelID = params.channelID();
    });

    initialDeposit(A);
    initialDeposit(B);
  });

  describeWithBlockRevert("register and refute", () => {
    const testsRegister = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "register with invalid channelID fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0]]) },
        desc: "register with wrong number of signatures fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "register with invalid signature fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.params.ledgerChannel = false; await tx.sign([parts[0], parts[0]]) },
        desc: "register non-ledger channel fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "register with valid state succeeds",
        shouldRevert: false,
      },
    ]

    testsRegister.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "2";
        await test.prepare(tx);
        let res = register(tx);
        if (test.shouldRevert) {
          await truffleAssert.reverts(res);
        } else {
          await assertRegister(res, tx);
        }
      })
    });

    it("register with validState twice does not revert", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "2";
      await tx.sign(parts);
      let res = register(tx);
      await truffleAssert.passes(res);
    });

    const testsRefute = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "refuting with invalid channelID fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "1"; await tx.sign(parts) },
        desc: "refuting with old state fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "refuting with invalid signature fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "refuting with validState succeeds",
        shouldRevert: false,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "5"; await tx.sign(parts) },
        desc: "refuting with higher state succeeds",
        shouldRevert: false,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.version = "6";
          await tx.sign(parts);
          await advanceBlockTime(timeout + 10);
        },
        desc: "refute after timeout fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          let actorIdx = 0;
          tx.state.version = "5";
          let txOldSerialized = tx.state.serialize();
          tx.state.version = "6";
          await tx.sign(parts);
          let res = progress(tx, txOldSerialized, actorIdx, tx.sigs[actorIdx]);
          await assertProgress(res, tx);
          tx.state.version = "7";
          await tx.sign(parts);
        },
        desc: "refute in FORCEEXEC fails",
        shouldRevert: true,
      },
    ]

    testsRefute.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "3";
        await test.prepare(tx);
        let timeoutIndex = 0
        let timeoutBefore = (await adj.disputes.call(tx.state.channelID))[timeoutIndex] as BN
        let res = register(tx);
        if (test.shouldRevert) {
          await truffleAssert.reverts(res);
        } else {
          await assertRegister(res, tx);
          //check timeout not changed programmatically in assertRefute?
          let timeoutAfter = (await adj.disputes.call(tx.state.channelID))[timeoutIndex] as BN
          assert(timeoutAfter.eq(timeoutBefore), "timeout must not change")
        }
      })
    });
  });

  describeWithBlockRevert("virtual channels", () => {
    itWithBlockRevert("register with app fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.params.virtualChannel = true;
      tx.state.channelID = tx.params.channelID();
      await tx.sign(parts);
      const res = register(tx);
      await truffleAssert.reverts(res, "cannot have app");
    });

    itWithBlockRevert("register with locked funds fails", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, zeroAddress);
      tx.params.virtualChannel = true;
      tx.state.channelID = tx.params.channelID();
      tx.state.outcome.locked = [new SubAlloc(zeroBytes32, [], [])];
      await tx.sign(parts);
      const res = register(tx);
      await truffleAssert.reverts(res, "cannot have locked funds");
    });

    itWithBlockRevert("register succeeds", async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, zeroAddress);
      tx.params.virtualChannel = true;
      tx.state.channelID = tx.params.channelID();
      await tx.sign(parts);
      const res = register(tx);
      await assertRegister(res, tx);
    });
  });

  describeWithBlockRevert("concludeFinal", () => {
    const testsConcludeFinal = [
      {
        prepare: async (tx: Transaction) => { tx.state.channelID = hash("wrongChannelID"); await tx.sign(parts) },
        desc: "concludeFinal with invalid channelID fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.params.ledgerChannel = false; await tx.sign(parts) },
        desc: "concludeFinal for non-ledger channel fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.isFinal = false; await tx.sign(parts) },
        desc: "concludeFinal with non-final state fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
        desc: "concludeFinal with invalid signature fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.locked = [dummySubAlloc]
          await tx.sign(parts)
        },
        desc: "concludeFinal with subchannels fails",
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "concludeFinal with valid state succeeds",
        shouldRevert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "concludeFinal with valid state twice fails",
        shouldRevert: true,
      },
    ]

    testsConcludeFinal.forEach(test => {
      it(test.desc, async () => {
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "3";
        tx.state.isFinal = true;
        await test.prepare(tx);
        let res = concludeFinal(tx);
        if (test.shouldRevert) {
          await truffleAssert.reverts(res);
        } else {
          await assertConcludeFinal(res, tx);
        }
      });
    });
  });

  describeWithBlockRevert("register, progress, conclude with subchannels", () => {
    /* Create channel tree
    *      root
    *     /    \
    *   sub0   sub3
    *   /  \
    * sub1 sub2
    *
    * subchannel 1 final, others non-final
    * register
    * conclude
    * withdraw
    */

    let ledgerChannel: Channel
    let subchannels: Channel[]

    function createChannel(nonce: string, version: string, balances: BN[], ledger: boolean): Channel {
      let assets = [asset]
      let params = new Params(app, timeout, nonce, parts, ledger)
      let outcome = new Allocation(assets, [[balances[0].toString(), balances[1].toString()]], [])
      let state = new State(params.channelID(), version, outcome, "0x00", false)
      return new Channel(params, state)
    }

    function createParentChannel(nonce: string, version: string, balances: BN[], subchannels: Channel[], ledger: boolean): Channel {
      let channel = createChannel(nonce, version, balances, ledger);
      channel.state.outcome.locked = subchannels.map(subchannel => toSubAlloc(subchannel.state));
      return channel;
    }

    function createInvalidSubchannel(): Channel {
      return createChannel("0", "0", balance, false);
    }

    function toSubAlloc(state: State): SubAlloc {
      let assetTotals = state.outcome.balances.map(balancesForAsset => balancesForAsset.reduce((acc, val) => acc.add(new BN(val)), new BN('0')));
      assetTotals = assetTotals.map((t, i) => t.add(state.outcome.locked.reduce((acc, val) => acc.add(new BN(val.balances[i])), new BN('0'))));
      return new SubAlloc(state.channelID, assetTotals.map(assetTotal => assetTotal.toString()), [0, 1])
    }

    let nonceCounter = 0;
    function newNonce(): string {
      return (++nonceCounter).toString();
    }

    before(async () => {
      subchannels = Array.from({length: 4}).map(_ => {
        let nonce = newNonce()
        let version = nonce + nonce
        let nonceAsNumber = Number(nonce)
        return createChannel(nonce, version, [ether(nonceAsNumber), ether(2 * nonceAsNumber)], false)
      })
      subchannels[1].state.isFinal = true
      subchannels[0].state.outcome.locked = [
        toSubAlloc(subchannels[1].state),
        toSubAlloc(subchannels[2].state),
      ]
      ledgerChannel = createParentChannel(
        newNonce(),
        "10",
        [ether(10), ether(20)],
        [subchannels[0], subchannels[3]],
        true,
      );

      const outcome = accumulatedOutcome(ledgerChannel, subchannels);
      await Promise.all(ledgerChannel.params.participants.map((user: string, userIndex: number) =>
        depositWithAssertions(ledgerChannel.state.channelID, user, outcome[userIndex])))
    })

    it("register with wrong assets fails", async () => {
      let subchannel = createChannel(newNonce(), "1", balance, false);
      let ledgerChannel = createParentChannel(
        newNonce(), "1", balance, [subchannel], true,
      );

      subchannel.state.outcome.assets = [new Asset(asset.chainID, zeroAddress)];
      let res = registerChannel(ledgerChannel, [subchannel]);
      await truffleAssert.reverts(res, "Asset: unequal holder");
    });

    it("register with wrong number of subchannels fails", async () => {
      let invalidSubchannels = subchannels.slice(-1);
      let res = registerChannel(ledgerChannel, invalidSubchannels);
      await truffleAssert.reverts(res, "subChannels: too short");
    });

    it("register with wrong subchannel ID fails", async () => {
      let invalidSubchannels = subchannels.slice();
      invalidSubchannels[0] = createInvalidSubchannel();
      let res = registerChannel(ledgerChannel, invalidSubchannels);
      await truffleAssert.reverts(res, "invalid sub-channel id");
    });

    it("register channel and subchannels", async () => {
      await registerWithAssertions(ledgerChannel, subchannels)
    });

    itWithBlockRevert("progress with wrong suballoc id fails", async () => {
      await advanceBlockTime(timeout + 1);
      let newState = createChannel(
        ledgerChannel.params.nonce,
        "11",
        [new BN(ledgerChannel.state.outcome.balances[0][0]), new BN(ledgerChannel.state.outcome.balances[0][1])],
        true,
      );
      newState.state.outcome.locked = ledgerChannel.state.outcome.locked.slice();
      newState.state.outcome.locked[0] = new SubAlloc(zeroBytes32, [], []);
      const sigs = await newState.state.sign(parts);
      let res = progress(newState, ledgerChannel.state, 0, sigs[0]);
      await truffleAssert.reverts(res, "SubAlloc: unequal ID");
    });

    itWithBlockRevert("progress succeeds", async () => {
      await advanceBlockTime(timeout + 1);
      let newState = createChannel(
        ledgerChannel.params.nonce,
        "11",
        [new BN(ledgerChannel.state.outcome.balances[0][0]), new BN(ledgerChannel.state.outcome.balances[0][1])],
        true,
      );
      newState.state.outcome.locked = ledgerChannel.state.outcome.locked;
      const sigs = await newState.state.sign(parts);
      let res = progress(newState, ledgerChannel.state, 0, sigs[0]);
      await assertProgress(res, newState);
    });

    itWithBlockRevert("conclude with wrong subchannel ID fails", async () => {
      await advanceBlockTime(2 * timeout + 1);
      let invalidSubchannels = subchannels.slice();
      invalidSubchannels[0] = createInvalidSubchannel();
      let res = concludeWithSubchannels(ledgerChannel, invalidSubchannels);
      await truffleAssert.reverts(res);
    });

    itWithBlockRevert("conclude with wrong subchannel state fails", async () => {
      await advanceBlockTime(2 * timeout + 1);
      let tmp = subchannels[0].state.version; // save state
      subchannels[0].state.version += "1"; // modify state
      let res = concludeWithSubchannels(ledgerChannel, subchannels);
      await truffleAssert.reverts(res, "invalid channel state");
      subchannels[0].state.version = tmp; // restore state
    });

    it("conclude ledger channel and subchannels", async () => {
      await advanceBlockTime(2 * timeout + 1);
      let res = concludeWithSubchannels(ledgerChannel, subchannels);
      await assertConclude(res, ledgerChannel, subchannels);
    });
  });

  describeWithBlockRevert("progress", async () => {
    let differentChannelID : string;

    before(async () => {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "4";
      await tx.sign(parts);
      let res = register(tx);
      await assertRegister(res, tx);

      let tx2 = new Transaction(parts, balance, timeout, "0x02", asset, app);
      tx2.state.version = "0";
      await tx2.sign(parts);
      let res2 = register(tx2);
      await assertRegister(res2, tx2);
      differentChannelID = tx2.params.channelID();
    });

    let defaultActorIdx = 0;

    const testsProgress = [
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with valid state before timeout fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          await advanceBlockTime(timeout + 10);
          tx.state.channelID = hash("unknownChannelID");
          await tx.sign(parts);
        },
        desc: "advance past timeout; progress with unknown channelID fails",
        actorIdx: 0,
        shouldRevert: true,
        revertMessage: "not registered",
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.channelID = differentChannelID;
          await tx.sign(parts);
        },
        desc: "progress with different channelID fails",
        actorIdx: 0,
        shouldRevert: true,
        revertMessage: "invalid params",
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign([accounts[8], accounts[8]]) },
        desc: "progress with invalid signature fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with invalid actorIdx fails",
        actorIdx: 1,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with actorIdx out of range fails",
        actorIdx: parts.length,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { tx.state.version = "6"; await tx.sign(parts) },
        desc: "progress with invalid version fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.balances = [];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of balances fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.assets = [];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of assets fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          let oldBalance = new BN(tx.state.outcome.balances[assetIndex][A]);
          tx.state.outcome.balances[assetIndex][A] = oldBalance.add(new BN(1)).toString();
          await tx.sign(parts);
        },
        desc: "progress with mismatching balances fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.locked = [dummySubAlloc];
          await tx.sign(parts);
        },
        desc: "progress with locked funds in new state fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.assets = [new Asset(asset.chainID, zeroAddress)];
          await tx.sign(parts);
        },
        desc: "progress with mismatching assets fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.state.outcome.balances = [[new BN(1).toString()]];
          await tx.sign(parts);
        },
        desc: "progress with wrong number of asset balances in new state fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => {
          tx.params.app = zeroAddress;
          await tx.sign(parts);
        },
        desc: "progress without app fails",
        actorIdx: 0,
        shouldRevert: true,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with valid state succeeds",
        actorIdx: 0,
        shouldRevert: false,
      },
      {
        prepare: async (tx: Transaction) => { await tx.sign(parts) },
        desc: "progress with the same valid state twice fails",
        actorIdx: 0,
        shouldRevert: true,
      },
    ]

    testsProgress.forEach(test => {
      it(test.desc, async () => {
        let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
        txOld.state.version = "4";
        let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx.state.version = "5";
        await test.prepare(tx);
        let res = progress(tx, txOld.state.serialize(), test.actorIdx, tx.sigs[defaultActorIdx]);
        if (test.shouldRevert) {
          await truffleAssert.reverts(res, test.revertMessage);
        } else {
          await assertProgress(res, tx);
        }
      })
    });

    it("progress with next valid state succeeds", async () => {
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "5";
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "6";
      await tx.sign(parts);
      let res = progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
      await assertProgress(res, tx);
    });

    itWithBlockRevert("progress after timeout fails", async () => {
      await advanceBlockTime(timeout + 1);
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "6";
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "7";
      await tx.sign(parts);
      let res = progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
      await truffleAssert.reverts(res);
    });

    itWithBlockRevert("progress in CONCLUDED fails", async () => {
      await advanceBlockTime(timeout + 1);

      //conclude first
      let txOld = new Transaction(parts, balance, timeout, nonce, asset, app);
      txOld.state.version = "6";
      let resConclude = conclude(txOld);
      await assertConclude(resConclude, txOld, []);

      //then test progress
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "7";
      await tx.sign(parts);
      let res = progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
      await truffleAssert.reverts(res);
    });

    function testWithModifiedOldState(description: string, prepare: any) {
      itWithBlockRevert(description, async () => {
        // prepare state and register
        let nonce = "1";
        let tx1 = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx1.state.version = "1";
        prepare(tx1);
        await tx1.sign(parts);
        let res0 = register(tx1);
        await assertRegister(res0, tx1);

        // test progress into new state
        let tx2 = new Transaction(parts, balance, timeout, nonce, asset, app);
        tx2.state.version = "2";
        await tx2.sign(parts);
        await advanceBlockTime(timeout + 1);
        let actorIdx = 0;
        let res1 = progress(tx2, tx1.state.serialize(), actorIdx, tx2.sigs[actorIdx]);
        await truffleAssert.reverts(res1);
      });
    }

    testWithModifiedOldState(
      "progress with wrong number of asset balances in old state fails",
      (tx: Transaction) => tx.state.outcome.balances = [[new BN(1).toString()]]
    );

    testWithModifiedOldState(
      "progress from final state fails",
      (tx: Transaction) => tx.state.isFinal = true
    );
  });

  describe("concludeFinal bypasses ongoing dispute", () => {
    async function prepare() {
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "2";
      await tx.sign(parts);
      let res = register(tx);
      await assertRegister(res, tx);
    }

    itWithBlockRevert("concludeFinal with lesser version", async () => {
      await prepare()
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "1";
      tx.state.isFinal = true;
      await tx.sign(parts);
      let res = concludeFinal(tx);
      await assertConcludeFinal(res, tx);
    });

    itWithBlockRevert("concludeFinal with greater version", async () => {
      await prepare()
      let tx = new Transaction(parts, balance, timeout, nonce, asset, app);
      tx.state.version = "3";
      tx.state.isFinal = true;
      await tx.sign(parts);
      let res = concludeFinal(tx);
      await assertConcludeFinal(res, tx);
    });
  });

  // These tests have to be skipped for the solidity-coverage test because they
  // rely on the contracts using a `block.chainid` call which currently does not
  // work due to incompatibility issues with solidity-coverage and ganache.
  describeWithBlockRevert("conclude with multi-ledger asset [ @skip-on-coverage ]", () => {
    let channelID: string;
    let tx: Transaction;

    async function prepare(asset: Asset) {
      let randNonce = randomHex(32);
      tx = new Transaction(parts, balance, timeout, randNonce, asset, app);
      channelID = tx.params.channelID();
      tx.state.isFinal = true;
      await tx.sign(parts);

      await depositWithAssertions(channelID, parts[A], balance[A]);
      await depositWithAssertions(channelID, parts[B], balance[B]);
    }

    it("concludeFinal asset same chain", async () => {
      await prepare(asset);
      await concludeFinal(tx);
      assert(await ah.settled.call(channelID), "expected channel to be settled");
    });

    it("concludeFinal asset different chain", async () => {
      const chainID = await getChainID();
      const diffAsset = new Asset(chainID + 1, ah.address);
      await prepare(diffAsset);
      await concludeFinal(tx);
      assert(!await ah.settled.call(channelID), "expected channel to not be settled");
    });
  });

  describeWithBlockRevert("conclude", () => {
    // *** conclude without refute and progress ***
    //register
    //conclude during dispute fails
    //advance time
    //conclude during forceexec fails
    //advance time
    //conclude succeeds

    let nonceCounter = 0;

    function prepareTransaction(nonce? : string): Transaction {
      if (nonce === undefined) {
        nonce = (++nonceCounter).toString()
      }
      return new Transaction(parts, balance, timeout, nonce, asset, app)
    }

    let tx: Transaction
    let txNoApp: Transaction

    before(async () => {
      // prepare
      tx = prepareTransaction()
      txNoApp = prepareTransaction()
      txNoApp.params.app = zeroAddress
      txNoApp.state.channelID = txNoApp.params.channelID()

      // fund and register
      async function fund(channel: Channel) {
        return Promise.all(channel.params.participants.map((user: string, userIndex: number) => {
          const amount = new BN(channel.state.outcome.balances[assetIndex][userIndex])
          return depositWithAssertions(channel.state.channelID, user, amount)
        }))
      }
      await fund(tx)
      await fund(txNoApp)
      await registerWithAssertions(tx, [])
      await registerWithAssertions(txNoApp, [])
    });

    it("conclude during DISPUTE fails", async () => {
      await truffleAssert.reverts(conclude(tx))
      await truffleAssert.reverts(conclude(txNoApp))
    });

    it("conclude with app during FORCEEXEC fails", async () => {
      await advanceBlockTime(timeout + 1)
      await truffleAssert.reverts(conclude(tx))
    });

    it("conclude non-ledger channel fails", async () => {
      let tx = prepareTransaction();
      tx.params.ledgerChannel = false;
      await truffleAssert.reverts(conclude(tx), "not ledger");
    });

    it("conclude without app skips FORCEEXEC and succeeds", async () => {
      let res = conclude(txNoApp);
      await assertConclude(res, txNoApp, []);
    });

    itWithBlockRevert("conclude after FORCEEXEC with invalid params fails", async () => {
      await advanceBlockTime(timeout + 1);
      let txInvalidParams = prepareTransaction(tx.params.nonce);
      txInvalidParams.params.participants[1] = tx.params.participants[0];
      await truffleAssert.reverts(conclude(txInvalidParams));
    });

    itWithBlockRevert("conclude after FORCEEXEC with invalid state fails", async () => {
      await advanceBlockTime(timeout + 1);
      const txProgressed = prepareTransaction(tx.params.nonce);
      txProgressed.state.incrementVersion();
      await truffleAssert.reverts(conclude(txProgressed), "invalid channel state");
    });

    it("conclude after FORCEEXEC succeeds", async () => {
      await advanceBlockTime(timeout + 1);
      let res = conclude(tx);
      await assertConclude(res, tx, []);
    });

    it("conclude twice fails", async () => {
      await truffleAssert.reverts(conclude(tx));
    });
  });
});
