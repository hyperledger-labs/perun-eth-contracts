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

import { ethers } from "hardhat";

import { Signer, BigNumberish, parseEther, formatEther, keccak256, getBytes } from "ethers";

export async function sign(data: string, account: string): Promise<string> {
  const provider = ethers.provider;
  const signer = await provider.getSigner(account);

  // Hash the data using keccak256
  const messageHash = keccak256(data);

  // Convert hash to bytes
  const messageHashBytes = getBytes(messageHash);
  const signature = await signer.signMessage(messageHashBytes);

  // Split the signature
  const sig = ethers.Signature.from(signature);

  // Combine r, s, and v
  let combinedSig = sig.r + sig.s.slice(2) + (sig.v).toString(16).padStart(2, '0');

  // Ensure v is 27 or 28
  let v = parseInt(combinedSig.slice(130, 132), 16);
  if (v < 27) {
    v += 27;
  }

  return combinedSig.slice(0, 130) + v.toString(16).padStart(2, '0');
}


export function ether(x: number | string): BigNumberish {
  return parseEther(x.toString());
}

export function wei2eth(x: BigNumberish): string {
  return formatEther(x);
}

export async function getAddresses(signers: Signer[]): Promise<string[]> {
  return Promise.all(signers.map(signer => signer.getAddress()));
}


export async function asyncWeb3Send(method: string, params: any[]): Promise<any> {
  const provider = ethers.provider;

  try {
    const result = await provider.send(method, params);
    return result;
  } catch (error) {
    console.error("Error sending request in asyncWeb3Send:", error);
    throw error;
  }
}


export async function currentTimestamp(): Promise<number> {
  const blockNumber = await ethers.provider.getBlockNumber();
  const block = await ethers.provider.getBlock(blockNumber);

  if (!block) {
    throw new Error("Failed to get the block");
  }

  return Number(block.timestamp);
}

export async function getChainID(): Promise<number> {
  const network = await ethers.provider.getNetwork();

  return Number(network.chainId);
}
