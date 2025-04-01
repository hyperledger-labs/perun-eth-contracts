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

import { should } from "chai";
should();
import { AssetHolderSetup } from "./Setup";
import { genericAssetHolderTest } from "./AssetHolder";
import { Adjudicator__factory } from "../typechain-types/factories/contracts/Adjudicator__factory";
import { AssetHolderETH__factory } from "../typechain-types/factories/contracts/AssetHolderETH__factory";
import { AssetHolderETHInterface, AssetHolderETH } from "../typechain-types/contracts/AssetHolderETH";
import { Adjudicator } from "../typechain-types/contracts/Adjudicator";
import { ethers } from "hardhat";
import { Signer, BigNumberish, TransactionResponse } from "ethers";

describe("AssetHolderETH", function () {
  let adj: Adjudicator;
  let ah: AssetHolderETH;
  let ahInterface: AssetHolderETHInterface;
  let setup: AssetHolderSetup;
  let adjAddress: string;

  before(async () => {
    const signers = await ethers.getSigners();
    const accounts: string[] = await Promise.all(signers.map(async (signer: Signer) => await signer.getAddress()));

    const AdjudicatorFactory = await ethers.getContractFactory("Adjudicator") as Adjudicator__factory;
    adj = await AdjudicatorFactory.deploy();
    await adj.waitForDeployment();
    adjAddress = await adj.getAddress();

    ahInterface = new ethers.Interface(AssetHolderETH__factory.abi) as AssetHolderETHInterface;

    setup = new AssetHolderSetup(undefined, accounts, deposit, ahInterface, balanceOf);
  });

  async function deposit(fid: string, amount: BigNumberish, from: string): Promise<TransactionResponse> {
    return setup.ah.deposit(fid, amount, { value: amount });
  }

  async function balanceOf(who: string): Promise<BigNumberish> {
    const balance = await ethers.provider.getBalance(who);
    return balance;
  }

  it("should deploy the AssetHolderETH contract", async () => {
    const AssetHolderETHFactory = await ethers.getContractFactory("AssetHolderETH") as AssetHolderETH__factory;
    ah = await AssetHolderETHFactory.deploy(setup.adj);

    await ah.waitForDeployment();
    setup.ah = ah;
    const adjAddr = setup.adj
    genericAssetHolderTest(setup);

  });

});
