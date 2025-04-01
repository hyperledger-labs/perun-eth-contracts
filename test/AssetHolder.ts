// Copyright 2025 - See NOTICE file for copyright holders.
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

import { assert, should, expect } from "chai";
should();


import { Authorization } from "./Channel";
import { sign, ether, wei2eth } from "../src/lib/web3";
import { fundingID, describeWithBlockRevert } from "../src/lib/test";
import { AssetHolderSetup } from "./Setup";
import { BigNumberish, TransactionReceipt, getBigInt } from "ethers";
import { ethers } from "hardhat";



// All accounts in `setup` must have `ether(100)` worth of funds.
export function genericAssetHolderTest(setup: AssetHolderSetup) {
  const finalBalance = [ether(20), ether(10)];
  const ahInterface = setup.ahInterface;

  async function assertHoldings(fid: string, amount: BigNumberish) {
    const c = await setup.ah.holdings(fid);
    const amountBigInt = getBigInt(amount);
    const cBigInt = getBigInt(c);
    assert(amountBigInt === cBigInt, `Wrong holdings. Wanted: ${wei2eth(amountBigInt)}, got: ${wei2eth(cBigInt)}`);
  }

  async function testDeposit(idx: number, amount: BigNumberish, cid: string) {
    const fid = fundingID(cid, setup.parts[idx].ethAddress);
    const oldBal = getBigInt(await setup.ah.holdings(fid));
    const depositTx = await setup.deposit(fid, amount, setup.recv[idx]);

    const receipt = await depositTx.wait();
    if (receipt === null) {
      throw new Error("Transaction receipt is null");
    }

    await assertEventEmitted(
      receipt,
      'Deposited',
      {},
      { fundingID: fid, amount: amount }
    );
    await assertHoldings(fid, oldBal + getBigInt(amount));
  }

  async function assertEventEmitted(
    receipt: TransactionReceipt,
    eventName: string,
    expectedArgs: { [key: string]: any },
    options: {
      fundingID?: string,
      amount?: BigNumberish,
      receiver?: string
    } = {}
  ): Promise<void> {
    const eventLog = receipt.logs.find((log) => {
      try {
        const parsedLog = ahInterface.parseLog(log);
        return parsedLog && parsedLog.name === eventName;
      } catch (error) {
        return false;
      }
    });

    expect(eventLog, `Event ${eventName} was not emitted`).to.not.be.undefined;

    if (eventLog) {
      const parsedLog = ahInterface.parseLog(eventLog);
      expect(parsedLog, `Parsed log for event ${eventName} is null`).to.not.be.null;

      if (parsedLog) {
        // Check specific fields for deposit and withdrawal events
        if (options.fundingID) {
          expect(parsedLog.args.fundingID, "fundingID mismatch").to.equal(options.fundingID);
        }
        if (options.amount) {
          const parsedAmount = getBigInt(parsedLog.args.amount);
          expect(parsedAmount, "amount mismatch").to.equal(getBigInt(options.amount));
        }
        if (options.receiver) {
          expect(parsedLog.args.receiver, "receiver mismatch").to.equal(options.receiver);
        }

        // Check all other expected arguments
        for (const [key, value] of Object.entries(expectedArgs)) {
          if (key !== 'fundingID' && key !== 'amount' && key !== 'receiver') {
            expect(parsedLog.args[key], `${key} mismatch`).to.equal(value);
          }
        }
      }
    }
  }

  async function testWithdraw(idx: number, amount: BigNumberish, cid: string) {
    const fid = fundingID(cid, setup.parts[idx].ethAddress);
    let balanceBefore = await setup.balanceOf(setup.recv[idx]);
    const amountBigInt = getBigInt(amount);
    let authorization = new Authorization(cid, setup.parts[idx], setup.recv[idx], amountBigInt.toString());
    let signature = await sign(authorization.encode(), setup.parts[idx].ethAddress);

    const withdrawTx = await setup.ah.withdraw(authorization, signature);// { from: setup.txSender }
    const receipt = await withdrawTx.wait();

    await assertEventEmitted(
      receipt,
      'Withdrawn',
      {},
      { fundingID: fid, amount: amount, receiver: setup.recv[idx] }
    );

    let balanceAfter = await setup.balanceOf(setup.recv[idx]);
    const balanceBeforeBigInt = getBigInt(balanceBefore);
    const balanceAfterBigInt = getBigInt(balanceAfter);
    assert(amountBigInt + balanceBeforeBigInt === balanceAfterBigInt, "wrong receiver balance");
  }


  describe("Funding...", () => {
    it("A deposits eth", async () => {
      await testDeposit(setup.A, ether(9), setup.channelID);
    });

    it("B deposits eth", async () => {
      await testDeposit(setup.B, ether(20), setup.channelID);
    });


    it("wrong msg.value", async () => {
      const id = fundingID(setup.channelID, setup.parts[setup.A].ethAddress);

      try {
        await setup.ah.deposit(id, ethers.parseEther("2"), { value: ethers.parseEther("1") });
        expect.fail("expected transaction to be reverted");
      } catch (error: unknown) {
        if (error instanceof Error) {
          const errorMessage = error.message.toLowerCase();
          if (errorMessage.includes("wrong amount of eth for deposit") ||
            errorMessage.includes("message value must be 0 for token deposit")) {
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      await assertHoldings(id, ethers.parseEther("9"));
    });


    it("A deposits eth", async () => {
      await testDeposit(setup.A, ether(1), setup.channelID);
    });
  })

  describe("Invalid withdraw", () => {
    it("unsettled channel should fail", async () => {
      assert(finalBalance.length == setup.parts.length);
      assert(await setup.ah.settled(setup.channelID) == false);

      const authorization = new Authorization(setup.channelID, setup.parts[setup.A], setup.recv[setup.A], finalBalance[setup.A].toString());
      const signature = await sign(authorization.encode(), setup.parts[setup.A].ethAddress);

      await expect(
        setup.ah.withdraw(authorization, signature)
      ).to.be.revertedWith("channel not settled");
    });
  });


  describe("Setting outcome", () => {
    it("wrong parts length", async () => {
      const wrongParts = [setup.parts[setup.A]];
      const adjudicatorSigner = await ethers.getSigner(setup.adj);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);
      await expect(
        ahAsAdjudicator.setOutcome(setup.channelID, wrongParts, finalBalance)
      ).to.be.revertedWith("participants length should equal balances");
    });

    it("wrong balances length", async () => {
      const wrongBals = [ether(1)];
      const adjudicatorSigner = await ethers.getSigner(setup.adj);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);

      await expect(
        ahAsAdjudicator.setOutcome(setup.channelID, setup.parts, wrongBals)
      ).to.be.revertedWith("participants length should equal balances");
    });

    it("wrong sender", async () => {
      const adjudicatorSigner = await ethers.getSigner(setup.txSender);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);
      await expect(
        ahAsAdjudicator.setOutcome(setup.channelID, setup.parts, finalBalance)
      ).to.be.revertedWith("can only be called by the adjudicator");
    });

    it("correct sender", async () => {
      const adjudicatorSigner = await ethers.getSigner(setup.adj);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);
      const tx = await ahAsAdjudicator.setOutcome(setup.channelID, setup.parts, finalBalance);

      const receipt = await tx.wait();

      await assertEventEmitted(
        receipt,
        'OutcomeSet',
        { channelID: setup.channelID }
      );

      const settled = await setup.ah.settled(setup.channelID);
      expect(settled).to.be.true;

      for (let i = 0; i < setup.parts.length; i++) {
        const id = fundingID(setup.channelID, setup.parts[i].ethAddress);
        await assertHoldings(id, finalBalance[i]);
      }
    });


    it("correct sender (twice)", async () => {
      const adjudicatorSigner = await ethers.getSigner(setup.adj);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);

      await expect(ahAsAdjudicator.setOutcome(setup.channelID, setup.parts, finalBalance))
        .to.be.revertedWith("trying to set already settled channel");
    });

  })

  describeWithBlockRevert("Invalid withdrawals", () => {
    it("withdraw with invalid signature", async () => {
      const authorization = new Authorization(setup.channelID, setup.parts[setup.A], setup.parts[setup.B].ethAddress, finalBalance[setup.A].toString());
      const signature = await sign(authorization.encode(), setup.parts[setup.B].ethAddress);
      await expect(setup.ah.withdraw(authorization, signature)).to.be.revertedWith("signature verification failed"); //, { from: setup.txSender }
    });

    it("invalid balance", async () => {
      const authorization = new Authorization(setup.channelID, setup.parts[setup.A], setup.parts[setup.B].ethAddress, ether(30).toString());
      const signature = await sign(authorization.encode(), setup.parts[setup.A].ethAddress);
      await expect(setup.ah.withdraw(authorization, signature)).to.be.revertedWith("insufficient funds"); //, { from: setup.txSender }
    });
  })

  describe("Withdraw", () => {
    it("A withdraws with valid allowance", async () => {
      await testWithdraw(setup.A, finalBalance[setup.A], setup.channelID);
    })
    it("B withdraws with valid allowance", async () => {
      await testWithdraw(setup.B, finalBalance[setup.B], setup.channelID);
    })

    it("A fails to overdraw with valid allowance", async () => {
      const authorization = new Authorization(setup.channelID, setup.parts[setup.A], setup.recv[setup.A], finalBalance[setup.A].toString());
      const signature = await sign(authorization.encode(), setup.parts[setup.A].ethAddress);
      await expect(setup.ah.withdraw(authorization, signature)).to.be.revertedWith("insufficient funds"); //, { from: setup.txSender }
    });
  })

  describe("Test underfunded channel", () => {
    let channelID: string

    it("initialize", () => {
      channelID = setup.unfundedChannelID;
    })

    it("A deposits eth", async () => {
      await testDeposit(setup.A, ether(1), channelID);
    });

    it("set outcome of the asset holder with deposit refusal", async () => {
      expect(await setup.ah.settled(channelID)).to.equal(false);
      const adjudicatorSigner = await ethers.getSigner(setup.adj);
      const ahAsAdjudicator = setup.ah.connect(adjudicatorSigner);
      const tx = await ahAsAdjudicator.setOutcome(channelID, setup.parts, finalBalance); // { from: setup.adj }
      const receipt = await tx.wait();

      const eventLog = receipt.logs.find((log: any) => {
        try {
          const parsedLog = ahInterface.parseLog(log);
          return parsedLog && parsedLog.name === 'OutcomeSet';
        } catch (error) {
          return false;
        }
      });

      expect(eventLog).to.not.be.undefined;
      if (eventLog) {
        const parsedLog = ahInterface.parseLog(eventLog);
        expect(parsedLog).to.not.be.null;
        if (parsedLog) {
          expect(parsedLog.args.channelID).to.equal(channelID);
        }
      }

      expect(await setup.ah.settled(channelID)).to.equal(true);

      const id = fundingID(channelID, setup.parts[setup.A].ethAddress);
      await assertHoldings(id, ether(1));
    });

    it("A fails to withdraw 2 eth after B's deposit refusal", async () => {
      let authorization = new Authorization(channelID, setup.parts[setup.A], setup.recv[setup.A], ether(2).toString());
      let signature = await sign(authorization.encode(), setup.parts[setup.A].ethAddress);

      await expect(
        setup.ah.withdraw(authorization, signature)
      ).to.be.revertedWith("insufficient funds");
    });

    it("A withdraws 1 ETH", async () => {
      await testWithdraw(setup.A, ether(1), channelID);
    })
  });
}
