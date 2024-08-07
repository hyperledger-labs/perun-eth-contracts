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

import { should } from "chai";
should();
import { PerunToken } from "../typechain-types/contracts/PerunToken";
import { AssetHolderERC20, AssetHolderERC20Interface } from "../typechain-types/contracts/AssetHolderERC20";

import { Adjudicator__factory } from "../typechain-types/factories/contracts/Adjudicator__factory";
import { PerunToken__factory } from "../typechain-types/factories/contracts/PerunToken__factory";

import { AssetHolderERC20__factory } from "../typechain-types/factories/contracts/AssetHolderERC20__factory";

import { Adjudicator } from "../typechain-types/contracts/Adjudicator";
import { ethers } from "hardhat";
import { Signer, BigNumberish, TransactionResponse } from "ethers";
import { ether } from "../src/lib/web3";
import { AssetHolderSetup } from "./Setup";
import { genericAssetHolderTest } from "./AssetHolder";

describe("AssetHolderERC20", function () {
  let adj: Adjudicator;
  let ah: AssetHolderERC20;
  let ahInterface: AssetHolderERC20Interface;
  let adjAddress: string;
  let tokenAddress: string;
  let setup: AssetHolderSetup;
  let token: PerunToken;
  let accounts: string[];

  before(async () => {
    const signers = await ethers.getSigners();
    accounts = await Promise.all(signers.map(async (signer: Signer) => await signer.getAddress()));

    const AdjudicatorFactory = await ethers.getContractFactory("Adjudicator") as Adjudicator__factory;
    adj = await AdjudicatorFactory.deploy();
    await adj.waitForDeployment();
    adjAddress = await adj.getAddress();

    ahInterface = new ethers.Interface(AssetHolderERC20__factory.abi) as AssetHolderERC20Interface;
    setup = new AssetHolderSetup(undefined, accounts, deposit, ahInterface, balanceOf);
  });

  async function deposit(fid: string, amount: BigNumberish): Promise<TransactionResponse> {
    await token.approve(await setup.ah.getAddress(), amount);
    return setup.ah.deposit(fid, amount, { value: 0 });
  }

  async function balanceOf(who: string): Promise<BigNumberish> {
    const balance = await token.balanceOf(who);
    return balance;
  }

  it("should deploy the PerunToken contract", async () => {
    const PerunTokenFactory = await ethers.getContractFactory("PerunToken") as PerunToken__factory;
    token = await PerunTokenFactory.deploy(accounts, ether(100));
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
  });

  it("should deploy the AssetHolderERC20 contract", async () => {
    const AssetHolderERC20Factory = await ethers.getContractFactory("AssetHolderERC20") as AssetHolderERC20__factory;
    ah = await AssetHolderERC20Factory.deploy(setup.adj, tokenAddress);
    await ah.waitForDeployment();
    setup.ah = ah;
    const adjAddr = await setup.ah.adjudicator();
  });
  describe("Generic Asset Holder Tests", function () {
    it("should pass generic asset holder tests", async function () {
      genericAssetHolderTest(setup);
    });
  });
});
