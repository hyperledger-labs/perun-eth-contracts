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

import { BigNumberish, keccak256, ethers, TransactionResponse } from "ethers";


// AssetHolderSetup is the setup for `genericAssetHolderTest`. 
export class AssetHolderSetup {
    channelID: string;
    unfundedChannelID: string;
    txSender: string;
    adj: string;
    recv: string[];
    parts: string[];
    A = 0; B = 1;
    accounts: string[];
    ah: any;
    ahInterface: any;
    deposit: (fid: string, amount: BigNumberish, from: string) => Promise<TransactionResponse>;
    balanceOf: (who: string) => Promise<BigNumberish>;

    constructor(
        ah: any,
        accounts: string[],
        deposit: (fid: string, amount: BigNumberish, from: string) => Promise<TransactionResponse>,
        ahInterface: any,
        balanceOf: (who: string) => Promise<BigNumberish>,
    ) {
        this.channelID = keccak256(ethers.randomBytes(32));
        this.unfundedChannelID = keccak256(ethers.randomBytes(32));
        this.txSender = accounts[5];
        this.adj = accounts[9];
        this.parts = [accounts[1], accounts[2]];
        this.recv = [accounts[3], accounts[4]];
        this.accounts = accounts;
        this.ah = ah;
        this.ahInterface = ahInterface;
        this.deposit = deposit;
        this.balanceOf = balanceOf;
    }
}
