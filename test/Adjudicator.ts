// Copyright 2024 - See NOTICE file for copyright holders.
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

import { expect, should, use } from "chai";
import chaiAsPromised from "chai-as-promised";
use(chaiAsPromised);

should();

import { BytesLike, getBytes, hexlify, toBeHex, keccak256, TransactionResponse, BigNumberish, getUint, TransactionReceipt, Log } from "ethers";
import { ethers } from "hardhat";

import { AdjudicatorInterface, Adjudicator } from "../typechain-types/contracts/Adjudicator";
import { TrivialApp } from "../typechain-types/contracts/TrivialApp";
import { AssetHolderETH } from "../typechain-types/contracts/AssetHolderETH";
import { Adjudicator__factory } from "../typechain-types/factories/contracts/Adjudicator__factory";
import { AssetHolderETH__factory } from "../typechain-types/factories/contracts/AssetHolderETH__factory";
import { TrivialApp__factory } from "../typechain-types/factories/contracts/TrivialApp__factory";
import { DisputePhase, Channel, SignedChannel, Params, Allocation, SubAlloc, Transaction, State, Asset } from "./Channel";
import {
    ether,
    getChainID
} from '../src/lib/web3';
import { fundingID, advanceBlockTime, describeWithBlockRevert, itWithBlockRevert } from "../src/lib/test";
const zeroAddress = "0x0000000000000000000000000000000000000000";
const zeroBytes32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
let appAddress: string;
let adjAddress: string;
let ahAddress: string;

describe("Adjudicator", function () {
    let adj: Adjudicator;
    let adjInterface: AdjudicatorInterface;
    let ah: AssetHolderETH;
    let appInstance: TrivialApp;
    let asset: Asset;
    let assetIndex = 0;
    let adjAccount: string;
    let parts: string[];
    const balance = [ether(10), ether(20)];
    const name = ["A", "B"];
    const timeout = 60;
    const nonce = "0xB0B0FACE";
    let params: Params;
    let channelID = "";
    const A = 0, B = 1;
    const dummySubAlloc = new SubAlloc(keccak256(toBeHex(0)), [], [0, 1]);

    function adjcall(method: any, tx: Transaction): Promise<TransactionResponse> {
        return method(
            tx.params.serialize(),
            tx.state.serialize(),
            tx.sigs,
            { from: adjAccount },

        );
    }

    async function register(tx: Transaction): Promise<TransactionResponse> {
        const ch = new SignedChannel(tx.params, tx.state, tx.sigs);
        return adj.register(
            ch.serialize(),
            [],
            { from: adjAccount },
        );
    }

    async function registerChannel(channel: Channel, subChannels: Channel[] = []): Promise<TransactionResponse> {
        return adj.register(
            (await channel.signed()).serialize(),
            await Promise.all(subChannels.map(async ch => (await ch.signed()).serialize())),
            { from: adjAccount, gasLimit: 500_000 },
        );
    }

    async function registerWithAssertions(channel: Channel, subChannels: Channel[]): Promise<void> {
        let res = await adj.register(
            (await channel.signed()).serialize(),
            await Promise.all(subChannels.map(async ch => (await ch.signed()).serialize())),
            { from: adjAccount }
        );
        const receipt = await res.wait();
        if (!receipt) {
            throw new Error(`Transaction receipt is null for transaction ${res.hash}`);
        }
        await assertRegister(receipt, channel);
    }

    function progress(ch: Channel, oldState: any, actorIdx: number, sig: string): Promise<TransactionResponse> {
        return adj.progress(
            ch.params.serialize(),
            oldState,
            ch.state.serialize(),
            actorIdx,
            sig,
            { from: adjAccount },
        );
    }

    function concludeFinal(tx: Transaction): Promise<TransactionResponse> {
        return adjcall(adj.concludeFinal, tx);
    }

    function conclude(tx: Transaction): Promise<TransactionResponse> {
        return adj.conclude(tx.params.serialize(), tx.state.serialize(), []);

    }

    function concludeWithSubchannels(ledgerChannel: Channel, subchannels: Channel[]): Promise<TransactionResponse> {
        return adj.conclude(
            ledgerChannel.params.serialize(),
            ledgerChannel.state.serialize(),
            subchannels.map(subchannel => subchannel.state.serialize()),
            { from: adjAccount, gasLimit: 500_000 }
        );
    }

    async function assertEventEmitted(
        receipt: TransactionReceipt,
        name: string,
        channel: Channel,
        phase: DisputePhase
    ): Promise<void> {
        const eventLog = receipt.logs.find((log: Log) => {
            try {
                const parsedLog = adjInterface.parseLog(log);
                return parsedLog && parsedLog.name === name;
            } catch (error) {
                return false;
            }
        });



        expect(eventLog, `Event ${name} was not emitted`).to.not.be.undefined;

        if (eventLog) {
            const parsedLog = adjInterface.parseLog(eventLog);
            expect(parsedLog, `Parsed log for event ${name} is null`).to.not.be.null;

            if (parsedLog) {


                expect(parsedLog.args.channelID, "channelID mismatch").to.equal(channel.params.channelID());
                expect(parsedLog.args.version, "version mismatch").to.equal(channel.state.version);
                expect(parsedLog.args.phase, "phase mismatch").to.equal(phase);
            }
        }
    }

    async function assertDisputePhase(channelID: string, phase: DisputePhase) {
        const channelIDBytes: BytesLike = getBytes(channelID);
        const dispute = await adj.disputes(channelIDBytes, { gasLimit: 500000 });

        const disputePhaseIndex = 4
        expect(BigInt(dispute[disputePhaseIndex])).to.equal(BigInt(phase), "wrong channel phase");
    }

    async function assertRegister(receipt: TransactionReceipt, channel: Channel): Promise<void> {
        assertEventEmitted(receipt, 'ChannelUpdate', channel, DisputePhase.DISPUTE);
        await assertDisputePhase(channel.state.channelID, DisputePhase.DISPUTE);
    }

    async function assertProgress(receipt: TransactionReceipt, channel: Channel): Promise<void> {
        assertEventEmitted(receipt, 'ChannelUpdate', channel, DisputePhase.FORCEEXEC);
        await assertDisputePhase(channel.state.channelID, DisputePhase.FORCEEXEC);
    }
    async function assertProgressLog(receipt: TransactionReceipt, channel: Channel): Promise<void> {
        await assertDisputePhase(channel.state.channelID, DisputePhase.FORCEEXEC);
    }

    async function assertConclude(receipt: TransactionReceipt, channel: Channel, subchannels: Channel[], checkOutcome: boolean = true) {
        /* this method currently only checks for the concluded and stored event of
        the ledger channel as it is not generally known which subchannels are not
        yet concluded. thus it is unclear for which subset of `subchannels` the
        events should be emitted. */
        assertEventEmitted(receipt, 'ChannelUpdate', channel, DisputePhase.CONCLUDED);

        await assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED);
        await Promise.all(subchannels.map(async channel => assertDisputePhase(channel.state.channelID, DisputePhase.CONCLUDED)));

        if (checkOutcome) {
            const expectedOutcome = accumulatedOutcome(channel, subchannels);
            await Promise.all(channel.params.participants.map(async (user, userIndex) => {
                let fundingIDString = fundingID(channel.state.channelID, user)
                let outcome = await ah.holdings(fundingIDString);
                expect(outcome).to.equal(expectedOutcome[userIndex], `outcome for user ${userIndex} not equal: got ${outcome}, expected ${expectedOutcome[userIndex]}`);
            }))
        }
    }

    async function assertConcludeFinal(receipt: TransactionReceipt, channel: Channel, checkOutcome: boolean = true) {
        await assertConclude(receipt, channel, [], checkOutcome);
    }

    async function depositWithAssertions(channelID: string, userDep: string, amount: BigNumberish) {
        const fid = fundingID(channelID, userDep);
        const signer = await ethers.getSigner(userDep);
        const signerAddress = await signer.getAddress();
        const signerBalance = await ethers.provider.getBalance(signerAddress);

        const depositTx = await ah.deposit(fid, amount, { value: amount });
        const receipt = await depositTx.wait();
        if (!receipt) {
            throw new Error(`Transaction receipt is null for transaction ${depositTx.hash}`);
        }

        if (receipt.status !== 1) {
            throw new Error(`Transaction failed with status ${receipt.status} for transaction ${depositTx.hash}`);
        }

    }

    async function initialDeposit(idx: number) {
        const bal = balance[idx];
        it(name[idx] + " deposits " + ethers.formatEther(bal) + " eth on the asset holder", async () => {
            const signer = await ethers.getSigner(parts[idx]);
            const signerAddress = await signer.getAddress();
            const signerBalance = await ethers.provider.getBalance(signerAddress);
            await depositWithAssertions(channelID, signerAddress, bal);
        });
    }

    function accumulatedOutcome(ledgerChannel: Channel, subchannels: Channel[]): BigNumberish[] {
        return ledgerChannel.params.participants.map((_, userIndex) => {
            let amount = getUint(ledgerChannel.state.outcome.balances[assetIndex][userIndex]);
            const total = subchannels.reduce((acc, channel) => {
                const subAmount = getUint(channel.state.outcome.balances[assetIndex][userIndex]);
                return acc + subAmount;
            }, amount);
            return total.toString();
        });
    }


    describe("setup", () => {
        const A = 0, B = 1;
        const timeout = 60;
        const nonce = "0xB0B0FACE";

        it("params setup", async () => {
            const signers = await ethers.getSigners();
            adjAccount = await signers[0].getAddress();
            const account1 = signers[2];
            const account2 = signers[3];
            parts = [await account1.getAddress(), await account2.getAddress()];
            const AdjudicatorFactory = await ethers.getContractFactory("Adjudicator") as Adjudicator__factory;
            adj = await AdjudicatorFactory.deploy();

            await adj.waitForDeployment();
            adjAddress = await adj.getAddress();

            const AssetHolderETHFactory = await ethers.getContractFactory("AssetHolderETH") as AssetHolderETH__factory;
            ah = await AssetHolderETHFactory.deploy(adjAddress);
            await ah.waitForDeployment();
            ahAddress = await ah.getAddress();
            adjInterface = new ethers.Interface(Adjudicator__factory.abi) as AdjudicatorInterface;
            const TrivialAppFactory = await ethers.getContractFactory("TrivialApp") as TrivialApp__factory;
            appInstance = await TrivialAppFactory.deploy();
            await appInstance.waitForDeployment();
            appAddress = await appInstance.getAddress();
            const chainIDBigInt = await ethers.provider.getNetwork().then(n => n.chainId);
            const chainID = Number(chainIDBigInt);
            asset = new Asset(chainID, await ah.getAddress());
            params = new Params(appAddress, timeout, nonce, [parts[A], parts[B]], true);
            channelID = params.channelID();

        });

        initialDeposit(A);
        initialDeposit(B);

    });



    describeWithBlockRevert("register and refute", () => {

        const testsRegister = [

            {
                prepare: async (tx: Transaction) => { tx.state.channelID = keccak256(ethers.toUtf8Bytes("wrongChannelID")); await tx.sign(parts) },
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
                prepare: async (tx: Transaction) => {
                    await tx.sign(parts);
                },
                desc: "register with valid state succeedsr",
                shouldRevert: false,
            },

        ]
        testsRegister.forEach(test => {
            it(test.desc, async () => {
                let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                tx.state.version = "2";
                await test.prepare(tx);

                if (test.shouldRevert) {
                    await expect(register(tx)).to.be.rejectedWith(Error);
                } else {
                    const res = await register(tx);
                    const receipt = await res.wait();
                    expect(receipt).to.not.be.null;
                    if (receipt) {
                        expect(receipt.status).to.equal(1);
                    } else {
                        throw new Error("transaction failed - receipt is null");
                    }
                    await assertRegister(receipt, tx);
                }
            });
        });


        it("register with validState twice does not revert", async () => {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "2";
            await tx.sign(parts);

            // First registration
            const firstRes = await register(tx);
            const firstReceipt = await firstRes.wait();
            expect(firstReceipt).to.not.be.null;
            if (firstReceipt) {
                expect(firstReceipt.status).to.equal(1);
            } else {
                throw new Error("transaction failed - first receipt is null");
            }
            await assertRegister(firstReceipt, tx);

            // Second registration
            const secondRes = await register(tx);
            const secondReceipt = await secondRes.wait();
            expect(secondReceipt).to.not.be.null;
            if (secondReceipt) {
                expect(secondReceipt.status).to.equal(1);
            } else {
                throw new Error("transaction failed - second receipt is null");
            }
            await assertRegister(secondReceipt, tx);
        });


        const testsRefute = [
            {
                prepare: async (tx: Transaction) => {
                    tx.state.channelID = ethers.keccak256(ethers.toUtf8Bytes("wrongChannelID"));
                    await tx.sign(parts);
                },
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


                    let res = await progress(tx, txOldSerialized, actorIdx, tx.sigs[actorIdx]);
                    const receipt = await res.wait();

                    expect(receipt).to.not.be.null;
                    if (receipt) {
                        expect(receipt.status).to.equal(1);
                    } else {
                        throw new Error("transaction failed - receipt is null");
                    }

                    await assertProgressLog(receipt, tx);
                    tx.state.version = "7";
                    await tx.sign(parts);
                },
                desc: "refute in FORCEEXEC fails",
                shouldRevert: true,
            },
        ]

        testsRefute.forEach(test => {
            it(test.desc, async () => {

                let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);

                tx.state.version = "3";
                await test.prepare(tx);
                let timeoutIndex = 0;

                // Use ethers.js to call the disputes function
                let timeoutBefore = (await adj.disputes(tx.state.channelID))[timeoutIndex];

                if (test.shouldRevert) {
                    await expect(register(tx)).to.be.rejectedWith(Error);
                } else {
                    const res = await register(tx);
                    const receipt = await res.wait();

                    expect(receipt).to.not.be.null;
                    if (receipt) {
                        expect(receipt.status).to.equal(1);
                    } else {
                        throw new Error("transaction failed - receipt is null");
                    }

                    await assertRegister(receipt, tx);

                    // Check timeout not changed
                    let timeoutAfter = (await adj.disputes(tx.state.channelID))[timeoutIndex];
                    expect(timeoutAfter).to.equal(timeoutBefore, "timeout must not change");
                }
            });
        });


    });

    describeWithBlockRevert("virtual channels", () => {

        itWithBlockRevert("register with app fails", async () => {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.params.virtualChannel = true;
            tx.state.channelID = tx.params.channelID();

            await tx.sign(parts);
            const res = register(tx);
            await expect(register(tx)).to.be.revertedWith("cannot have app");
        });

        itWithBlockRevert("register with locked funds fails", async () => {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, zeroAddress);
            tx.params.virtualChannel = true;
            tx.state.channelID = tx.params.channelID();
            tx.state.outcome.locked = [new SubAlloc(zeroBytes32, [], [])];

            await tx.sign(parts);

            await expect(register(tx)).to.be.revertedWith("cannot have locked funds");
        });

        itWithBlockRevert("register succeeds", async () => {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, zeroAddress);
            tx.params.virtualChannel = true;
            tx.state.channelID = tx.params.channelID();
            await tx.sign(parts);

            const res = await register(tx);
            const receipt = await res.wait();

            expect(receipt).to.not.be.null;
            if (receipt) {
                expect(receipt.status).to.equal(1);
            } else {
                throw new Error("transaction failed - receipt is null");
            }

            await assertRegister(receipt, tx);
        });


    });

    describeWithBlockRevert("concludeFinal", () => {

        const testsConcludeFinal = [

            {
                prepare: async (tx: Transaction) => { tx.state.channelID = ethers.keccak256(ethers.toUtf8Bytes("wrongChannelID")); await tx.sign(parts) },
                desc: "concludeFinal with invalid channelID fails",
                shouldRevert: true,
                revertReason: "invalid params",
            },
            {
                prepare: async (tx: Transaction) => { tx.params.ledgerChannel = false; await tx.sign(parts) },
                desc: "concludeFinal for non-ledger channel fails",
                shouldRevert: true,
                revertReason: "not ledger",
            },
            {
                prepare: async (tx: Transaction) => { tx.state.isFinal = false; await tx.sign(parts) },
                desc: "concludeFinal with non-final state fails",
                shouldRevert: true,
                revertReason: "state not final",
            },
            {
                prepare: async (tx: Transaction) => { await tx.sign([parts[0], parts[0]]) },
                desc: "concludeFinal with invalid signature fails",
                shouldRevert: true,
                revertReason: "invalid signature",
            },
            {
                prepare: async (tx: Transaction) => {
                    tx.state.outcome.locked = [dummySubAlloc]
                    await tx.sign(parts)
                },
                desc: "concludeFinal with subchannels fails",
                shouldRevert: true,
                revertReason: "cannot have sub-channels",
            },
            {
                prepare: async (tx: Transaction) => { await tx.sign(parts) },
                desc: "concludeFinal with valid state succeeds",
                shouldRevert: false,
                revertReason: "",
            },
            {
                prepare: async (tx: Transaction) => { await tx.sign(parts) },
                desc: "concludeFinal with valid state twice fails",
                shouldRevert: true,
                revertReason: "channel already concluded",
            },
        ]

        testsConcludeFinal.forEach(test => {
            it(test.desc, async () => {
                let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                tx.state.version = "3";
                tx.state.isFinal = true;

                await test.prepare(tx);

                const adjAddressDuringTest = await ah.adjudicator();


                if (test.shouldRevert) {
                    await expect(concludeFinal(tx)).to.be.revertedWith(test.revertReason);

                } else {
                    const res = await concludeFinal(tx);

                    const receipt = await res.wait();
                    if (receipt === null) {
                        throw new Error(`Transaction receipt is null for transaction ${res.hash}`);
                    }
                    await assertConcludeFinal(receipt, tx);

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

        function createChannel(nonce: string, version: string, balances: BigNumberish[], ledger: boolean): Channel {
            let assets = [asset];
            let params = new Params(appAddress, timeout, nonce, parts, ledger);
            let outcome = new Allocation(
                assets,
                [[
                    getUint(balances[0]).toString(),
                    getUint(balances[1]).toString()
                ]],
                []
            );
            let state = new State(params.channelID(), version, outcome, "0x00", false);
            return new Channel(params, state);
        }
        function createParentChannel(nonce: string, version: string, balances: BigNumberish[], subchannels: Channel[], ledger: boolean): Channel {
            let channel = createChannel(nonce, version, balances, ledger);
            channel.state.outcome.locked = subchannels.map(subchannel => toSubAlloc(subchannel.state));
            return channel;
        }

        function createInvalidSubchannel(): Channel {
            return createChannel("0", "0", balance, false);
        }


        function toSubAlloc(state: State): SubAlloc {
            let assetTotals = state.outcome.balances.map(balancesForAsset =>
                balancesForAsset.reduce((acc, val) =>
                    getUint(acc) + getUint(val),
                    0n
                )
            );

            assetTotals = assetTotals.map((t, i) =>
                getUint(t) + state.outcome.locked.reduce((acc, val) =>
                    getUint(acc) + getUint(val.balances[i]),
                    0n
                )
            );

            return new SubAlloc(
                state.channelID,
                assetTotals.map(assetTotal => assetTotal.toString()),
                [0, 1]
            );
        }

        let nonceCounter = 0;
        function newNonce(): string {
            return (++nonceCounter).toString();
        }

        before(async () => {
            subchannels = Array.from({ length: 4 }).map(_ => {
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
            await expect(res).to.be.revertedWith("Asset: unequal holder");
        });

        it("register with wrong number of subchannels fails", async () => {
            let invalidSubchannels = subchannels.slice(-1);
            let res = registerChannel(ledgerChannel, invalidSubchannels);
            await expect(res).to.be.revertedWith("subChannels: too short");
        });

        it("register with wrong subchannel ID fails", async () => {
            let invalidSubchannels = subchannels.slice();
            invalidSubchannels[0] = createInvalidSubchannel();
            let res = registerChannel(ledgerChannel, invalidSubchannels);
            await expect(res).to.be.revertedWith("invalid sub-channel id");
        });

        it("register channel and subchannels", async () => {
            await registerWithAssertions(ledgerChannel, subchannels)
        });

        itWithBlockRevert("progress with wrong suballoc id fails", async () => {
            await advanceBlockTime(timeout + 1);
            let newState = createChannel(
                ledgerChannel.params.nonce,
                "11",
                [ledgerChannel.state.outcome.balances[0][0], ledgerChannel.state.outcome.balances[0][1]],
                true,
            );
            newState.state.outcome.locked = ledgerChannel.state.outcome.locked.slice();
            newState.state.outcome.locked[0] = new SubAlloc(zeroBytes32, [], []);
            const sigs = await newState.state.sign(parts);
            let res = progress(newState, ledgerChannel.state, 0, sigs[0]);
            await expect(res).to.be.revertedWith("SubAlloc: unequal ID");
        });

        itWithBlockRevert("progress succeeds", async () => {
            await advanceBlockTime(timeout + 1);
            let newState = createChannel(
                ledgerChannel.params.nonce,
                "11",
                [ledgerChannel.state.outcome.balances[0][0], ledgerChannel.state.outcome.balances[0][1]],
                true,
            );
            newState.state.outcome.locked = ledgerChannel.state.outcome.locked;
            const sigs = await newState.state.sign(parts);
            let res = await progress(newState, ledgerChannel.state, 0, sigs[0]);
            const receipt = await res.wait();



            expect(res).to.not.be.null;
            if (res) {
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);

                    const isSettled = await ah.settled(channelID);
                    expect(isSettled).to.be.false;
                } else {
                    throw new Error("Progress transaction failed - receipt is null");
                }
            } else {
                throw new Error("Progress transaction failed - response is null");
            }

            await assertProgress(receipt, newState);
        });

        itWithBlockRevert("conclude with wrong subchannel ID fails", async () => {
            await advanceBlockTime(2 * timeout + 1);
            let invalidSubchannels = subchannels.slice();
            invalidSubchannels[0] = createInvalidSubchannel();
            let res = concludeWithSubchannels(ledgerChannel, invalidSubchannels);
            await expect(res).to.be.reverted;
        });

        itWithBlockRevert("conclude with wrong subchannel state fails", async () => {
            await advanceBlockTime(2 * timeout + 1);
            let tmp = subchannels[0].state.version; // save state
            subchannels[0].state.version += "1"; // modify state
            let res = concludeWithSubchannels(ledgerChannel, subchannels);
            await expect(res).to.be.revertedWith("invalid channel state");
            subchannels[0].state.version = tmp; // restore state
        });

        it("conclude ledger channel and subchannels", async () => {
            await advanceBlockTime(2 * timeout + 1);
            let res = await concludeWithSubchannels(ledgerChannel, subchannels);
            const receipt = await res.wait();
            expect(receipt).to.not.be.null;
            if (receipt) {
                expect(receipt.status).to.equal(1);
            } else {
                throw new Error("transaction failed - receipt is null");
            }
            await assertConclude(receipt, ledgerChannel, subchannels);
        });
    });

    describeWithBlockRevert("progress", async () => {
        let differentChannelID: string;

        before(async () => {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "4";
            await tx.sign(parts);
            let res = await register(tx);
            const receipt = await res.wait();
            expect(receipt).to.not.be.null;
            if (receipt) {
                expect(receipt.status).to.equal(1);
            } else {
                throw new Error("Transaction failed - receipt is null for tx");
            }
            await assertRegister(receipt, tx);

            let tx2 = new Transaction(parts, balance, timeout, "0x02", asset, appAddress);
            tx2.state.version = "0";
            await tx2.sign(parts);
            let res2 = await register(tx2);
            const receipt2 = await res2.wait();
            expect(receipt2).to.not.be.null;
            if (receipt2) {
                expect(receipt2.status).to.equal(1);
            } else {
                throw new Error("transaction failed - receipt is null for tx2");
            }
            await assertRegister(receipt2, tx2);
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
                    tx.state.channelID = keccak256("unknownChannelID");
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
                prepare: async (tx: Transaction) => { await tx.sign([parts[8], parts[8]]) },
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
                    let oldBalance = getUint(tx.state.outcome.balances[assetIndex][A]);
                    tx.state.outcome.balances[assetIndex][A] = (oldBalance + 1n).toString();
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
                    tx.state.outcome.balances = [["1"]]; // Directly use a string representation
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
                let txOld = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                txOld.state.version = "4";
                let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                tx.state.version = "5";
                await test.prepare(tx);
                let res = await progress(tx, txOld.state.serialize(), test.actorIdx, tx.sigs[defaultActorIdx]);

                if (test.shouldRevert) {
                    await expect(res).to.be.revertedWith(test.revertMessage || "");
                } else {
                    expect(res).to.not.be.null;
                    if (res) {
                        const receipt = await res.wait();
                        expect(receipt).to.not.be.null;
                        if (receipt) {
                            expect(receipt.status).to.equal(1);
                            await assertProgress(receipt, tx);
                        } else {
                            throw new Error("Transaction failed - receipt is null");
                        }
                    } else {
                        throw new Error("Transaction failed - response is null");
                    }
                }

            })
        });

        it("progress with next valid state succeeds", async () => {
            let txOld = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            txOld.state.version = "5";
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "6";
            await tx.sign(parts);
            let res = await progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertProgress(receipt, tx);
                } else {
                    throw new Error("Transaction failed - receipt is null");
                }
            } else {
                throw new Error("Transaction failed - response is null");
            }
        });

        itWithBlockRevert("progress after timeout fails", async () => {
            await advanceBlockTime(timeout + 1);
            let txOld = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            txOld.state.version = "6";
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "7";
            await tx.sign(parts);
            let res = await progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx]);
            expect(res).to.be.reverted;
            await expect(
                progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx])
            ).to.be.revertedWith("Channel timed out");
        });
        itWithBlockRevert("progress in CONCLUDED fails", async () => {
            await advanceBlockTime(timeout + 1);

            // Conclude first
            let txOld = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            txOld.state.version = "6";
            let resConclude = await conclude(txOld);

            // Check if conclude transaction was successful
            expect(resConclude).to.not.be.null;
            if (resConclude) {
                const receiptConclude = await resConclude.wait();
                expect(receiptConclude).to.not.be.null;
                if (receiptConclude) {
                    expect(receiptConclude.status).to.equal(1);
                    await assertConclude(receiptConclude, txOld, []);
                } else {
                    throw new Error("Conclude transaction failed - receipt is null");
                }
            } else {
                throw new Error("Conclude transaction failed - response is null");
            }

            // Then test progress
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "7";
            await tx.sign(parts);

            // Expect the progress transaction to be reverted
            await expect(
                progress(tx, txOld.state.serialize(), defaultActorIdx, tx.sigs[defaultActorIdx])
            ).to.be.revertedWith("Channel concluded");
        });

        function testWithModifiedOldState(description: string, prepare: any) {
            itWithBlockRevert(description, async () => {
                // prepare state and register
                let nonce = "1";
                let tx1 = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                tx1.state.version = "1";
                prepare(tx1);
                await tx1.sign(parts);
                let res0 = await register(tx1);

                // Check if register transaction was successful
                expect(res0).to.not.be.null;
                if (res0) {
                    const receipt0 = await res0.wait();
                    expect(receipt0).to.not.be.null;
                    if (receipt0) {
                        expect(receipt0.status).to.equal(1);
                        await assertRegister(receipt0, tx1);
                    } else {
                        throw new Error("Register transaction failed - receipt is null");
                    }
                } else {
                    throw new Error("Register transaction failed - response is null");
                }

                // test progress into new state
                let tx2 = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
                tx2.state.version = "2";
                await tx2.sign(parts);
                await advanceBlockTime(timeout + 1);
                let actorIdx = 0;

                // Expect the progress transaction to be reverted
                await expect(
                    progress(tx2, tx1.state.serialize(), actorIdx, tx2.sigs[actorIdx])
                ).to.be.revertedWith("Invalid state transition");
            });
        }
        testWithModifiedOldState(
            "progress with wrong number of asset balances in old state fails",
            (tx: Transaction) => tx.state.outcome.balances = [[(getUint("1") + 0n).toString()]]
        );

        testWithModifiedOldState(
            "progress from final state fails",
            (tx: Transaction) => tx.state.isFinal = true
        );
    });

    describe("concludeFinal bypasses ongoing dispute", () => {

        async function prepare() {
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "2";
            await tx.sign(parts);
            let res = await register(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertRegister(receipt, tx);
                } else {
                    throw new Error("Register transaction failed - receipt is null");
                }
            } else {
                throw new Error("Register transaction failed - response is null");
            }
        }

        itWithBlockRevert("concludeFinal with lesser version", async () => {
            await prepare();
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "1";
            tx.state.isFinal = true;
            await tx.sign(parts);
            let res = await concludeFinal(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertConcludeFinal(receipt, tx);
                } else {
                    throw new Error("ConcludeFinal transaction failed - receipt is null");
                }
            } else {
                throw new Error("ConcludeFinal transaction failed - response is null");
            }
        });

        itWithBlockRevert("concludeFinal with greater version", async () => {
            await prepare();
            let tx = new Transaction(parts, balance, timeout, nonce, asset, appAddress);
            tx.state.version = "3";
            tx.state.isFinal = true;
            await tx.sign(parts);
            let res = await concludeFinal(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertConcludeFinal(receipt, tx);
                } else {
                    throw new Error("ConcludeFinal transaction failed - receipt is null");
                }
            } else {
                throw new Error("ConcludeFinal transaction failed - response is null");
            }
        });
    });

    // These tests have to be skipped for the solidity-coverage test because they
    // rely on the contracts using a `block.chainid` call which currently does not
    // work due to incompatibility issues with solidity-coverage and ganache.
    describeWithBlockRevert("conclude with multi-ledger asset [ @skip-on-coverage ]", () => {
        let channelID: string;
        let tx: Transaction;

        async function prepare(asset: Asset) {
            let randNonce = hexlify(ethers.randomBytes(32));
            tx = new Transaction(parts, balance, timeout, randNonce, asset, appAddress);
            channelID = tx.params.channelID();
            tx.state.isFinal = true;
            await tx.sign(parts);

            await depositWithAssertions(channelID, parts[A], balance[A]);
            await depositWithAssertions(channelID, parts[B], balance[B]);
        }

        it("concludeFinal asset same chain", async () => {
            await prepare(asset);

            let res = await concludeFinal(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);

                    const isSettled = await ah.settled(channelID);
                    expect(isSettled).to.be.true;
                } else {
                    throw new Error("ConcludeFinal transaction failed - receipt is null");
                }
            } else {
                throw new Error("ConcludeFinal transaction failed - response is null");
            }
        });

        it("concludeFinal asset different chain", async () => {
            const chainID = await getChainID();
            const ahAddress = await ah.getAddress();
            const diffAsset = new Asset(chainID + 1, ahAddress);
            await prepare(diffAsset);

            let tx = new Transaction(parts, balance, timeout, nonce, diffAsset, appAddress);
            tx.state.version = "2";
            tx.state.isFinal = true;
            await tx.sign(parts);

            let res = await concludeFinal(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);

                    // Check if the channel is not settled
                    const isSettled = await ah.settled(channelID);
                    expect(isSettled).to.be.false;
                } else {
                    throw new Error("ConcludeFinal transaction failed - receipt is null");
                }
            } else {
                throw new Error("ConcludeFinal transaction failed - response is null");
            }
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

        function prepareTransaction(nonce?: string): Transaction {
            if (nonce === undefined) {
                nonce = (++nonceCounter).toString()
            }
            return new Transaction(parts, balance, timeout, nonce, asset, appAddress)
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
                    const amount = channel.state.outcome.balances[assetIndex][userIndex]
                    return depositWithAssertions(channel.state.channelID, user, amount)
                }))
            }
            await fund(tx)
            await fund(txNoApp)
            await registerWithAssertions(tx, [])
            await registerWithAssertions(txNoApp, [])
        });

        it("conclude during DISPUTE fails", async () => {
            await expect(conclude(tx)).to.be.revertedWith("timeout not passed yet");
            await expect(conclude(txNoApp)).to.be.revertedWith("timeout not passed yet");
        });

        it("conclude with app during FORCEEXEC fails", async () => {
            await advanceBlockTime(timeout + 1);
            await expect(conclude(tx)).to.be.revertedWith("timeout not passed yet");
        });

        it("conclude non-ledger channel fails", async () => {
            let tx = prepareTransaction();
            tx.params.ledgerChannel = false;
            await expect(conclude(tx)).to.be.revertedWith("not ledger");
        });

        it("conclude without app skips FORCEEXEC and succeeds", async () => {
            let res = await conclude(txNoApp);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertConclude(receipt, txNoApp, []);
                } else {
                    throw new Error("Conclude transaction failed - receipt is null");
                }
            } else {
                throw new Error("Conclude transaction failed - response is null");
            }
        });

        itWithBlockRevert("conclude after FORCEEXEC with invalid params fails", async () => {
            await advanceBlockTime(timeout + 1);
            let txInvalidParams = prepareTransaction(tx.params.nonce);
            txInvalidParams.params.participants[1] = tx.params.participants[0];

            await expect(conclude(txInvalidParams)).to.be.revertedWith("invalid params");
        });

        itWithBlockRevert("conclude after FORCEEXEC with invalid state fails", async () => {
            await advanceBlockTime(timeout + 1);
            const txProgressed = prepareTransaction(tx.params.nonce);
            txProgressed.state.incrementVersion();

            await expect(conclude(txProgressed)).to.be.revertedWith("invalid channel state");
        });


        itWithBlockRevert("conclude after FORCEEXEC succeeds", async () => {
            await advanceBlockTime(timeout + 1);

            let res = await conclude(tx);

            expect(res).to.not.be.null;
            if (res) {
                const receipt = await res.wait();
                expect(receipt).to.not.be.null;
                if (receipt) {
                    expect(receipt.status).to.equal(1);
                    await assertConclude(receipt, tx, []);
                } else {
                    throw new Error("Conclude transaction failed - receipt is null");
                }
            } else {
                throw new Error("Conclude transaction failed - response is null");
            }
        });

        itWithBlockRevert("conclude twice fails", async () => {
            await expect(conclude(tx)).to.be.revertedWith("timeout not passed yet");
        });
    });
});
