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


import { asyncWeb3Send } from "./web3";
import { ethers } from "hardhat";
import { AbiCoder, keccak256 } from "ethers";

export function sleep(milliseconds: any) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function advanceBlockTime(time: number): Promise<any> {
  await asyncWeb3Send('evm_increaseTime', [time]);
  return asyncWeb3Send('evm_mine', []);
}

export function fundingID(channelID: string, participant: string): string {
  const paddedChannelID = ethers.zeroPadValue(channelID, 32);

  const abiCoder = AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['bytes32', 'address'],
    [paddedChannelID, participant]
  );

  return keccak256(encoded);
}

// describe test suite followed by blockchain revert
export function describeWithBlockRevert(name: string, tests: any) {
  describe(name, () => {
    let snapshot_id: number;

    before("take snapshot before first test", async () => {
      const result = (await asyncWeb3Send('evm_snapshot', []));
      snapshot_id = result;
    });

    after("restore snapshot after last test", async () => {
      await asyncWeb3Send('evm_revert', [snapshot_id]);
    });

    tests();
  });
}

export function itWithBlockRevert(name: string, test: any) {
  it(name, async () => {
    const result = (await asyncWeb3Send('evm_snapshot', []));
    const snapshot_id = result;

    try {
      await test();
    } finally {
      await asyncWeb3Send('evm_revert', [snapshot_id]);
    }
  });
}