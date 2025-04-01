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

import { sign } from "../src/lib/web3";
import { ethers } from "hardhat";
import { BigNumberish, keccak256, AbiCoder, getBytes } from "ethers";

export enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

export class Channel {
  params: Params
  state: State

  constructor(params: Params, state: State) {
    this.params = params;
    this.state = state;
  }

  async signed(): Promise<SignedChannel> {
    const sigs = await this.state.sign(this.params.participants);
    return new SignedChannel(this.params, this.state, sigs);
  }
}

export class SignedChannel extends Channel {
  sigs: string[];

  constructor(params: Params, state: State, sigs: string[]) {
    super(params, state);
    this.sigs = sigs;
  }

  serialize() {
    return {
      params: this.params.serialize(),
      state: this.state.serialize(),
      sigs: this.sigs,
    };
  }
}

export class Participant {
  ethAddress: string;
  ccAddress: string;

  constructor(ethAddress: string, ccAddress: string) {
    this.ethAddress = ethAddress;
    this.ccAddress = ccAddress;
  }
}

export class Params {
  challengeDuration: number;
  nonce: string;
  app: string;
  participants: Participant[];
  ledgerChannel: boolean;
  virtualChannel: boolean;

  constructor(app: string, challengeDuration: number, nonce: string, participants: Participant[], ledgerChannel: boolean) {
    this.app = app;
    this.challengeDuration = challengeDuration;
    this.nonce = nonce;
    this.participants = participants;
    this.ledgerChannel = ledgerChannel;
    this.virtualChannel = false;
  }

  serialize() {
    return {
      app: this.app,
      challengeDuration: this.challengeDuration,
      nonce: this.nonce,
      participants: this.participants.map(p => ({
        ethAddress: p.ethAddress,
        ccAddress: p.ccAddress
      })),
      ledgerChannel: this.ledgerChannel,
      virtualChannel: this.virtualChannel,
    };
  }

  encode() {
    const abiCoder = AbiCoder.defaultAbiCoder();

    const paramsType = [
      "tuple(uint256 challengeDuration, uint256 nonce, tuple(address ethAddress, bytes ccAddress)[] participants, address app, bool ledgerChannel, bool virtualChannel)"
    ];

    return abiCoder.encode(paramsType, [{
      challengeDuration: this.challengeDuration,
      nonce: this.nonce,
      participants: this.participants.map(p => ({
        ethAddress: p.ethAddress,
        ccAddress: p.ccAddress
      })),
      app: this.app,
      ledgerChannel: this.ledgerChannel,
      virtualChannel: this.virtualChannel
    }]);
  }

  channelID() {
    return keccak256(this.encode());
  }
}

export class State {
  channelID: string;
  version: string;
  outcome: Allocation;
  appData: string;
  isFinal: boolean;

  constructor(_channelID: string, _version: string, _outcome: Allocation, _appData: string, _isFinal: boolean) {
    this.channelID = _channelID;
    this.version = _version;
    this.outcome = _outcome;
    this.appData = _appData;
    this.isFinal = _isFinal;
  }

  serialize() {
    return {
      channelID: this.channelID,
      version: this.version,
      outcome: this.outcome.serialize(),
      appData: this.appData,
      isFinal: this.isFinal
    }
  }

  encode() {
    const abiCoder = new ethers.AbiCoder();
    const stateType = [
      'tuple(bytes32 channelID, uint64 version, tuple(tuple(uint256 chainID, address ethHolder, bytes ccHolder)[] assets, uint256[] backends, uint256[][] balances, tuple(bytes32 ID, uint256[] balances, uint16[] indexMap)[] locked) outcome, bytes appData, bool isFinal)'
    ];

    return abiCoder.encode(stateType, [{
      channelID: this.channelID,
      version: this.version,
      outcome: this.outcome,
      appData: this.appData,
      isFinal: this.isFinal
    }]);
  }


  incrementVersion() {
    this.version = (Number(this.version) + 1).toString();
  }

  async sign(signers: Participant[]): Promise<string[]> {
    return Promise.all(signers.map(signer => sign(this.encode(), signer.ethAddress)));
  }
}

export class Asset {
  chainID: number;
  ethHolder: string;
  ccHolder: string;

  constructor(_chainID: number, _ethHolder: string, _ccHolder: string) {
    this.chainID = _chainID;
    this.ethHolder = _ethHolder;
    this.ccHolder = _ccHolder;
  }
}

export class Allocation {
  assets: Asset[];
  backends: number[];
  balances: string[][];
  locked: SubAlloc[];

  constructor(_assets: Asset[], _backends: number[], _balances: string[][], _locked: SubAlloc[]) {
    this.assets = _assets;
    this.backends = _backends;
    this.balances = _balances;
    this.locked = _locked;
  }

  serialize() {
    let _locked: any[] = this.locked.map(e => e.serialize());
    return { assets: this.assets, backends: this.backends, balances: this.balances, locked: _locked };
  }
}

export class SubAlloc {
  ID: string;
  balances: string[];
  indexMap: number[];

  constructor(id: string, balances: string[], indexMap: number[]) {
    this.ID = id;
    this.balances = balances;
    this.indexMap = indexMap;
  }

  serialize() {
    return { ID: this.ID, balances: this.balances, indexMap: this.indexMap };
  }
}

export class Transaction extends Channel {
  sigs: string[];

  constructor(parts: Participant[], balances: BigNumberish[], challengeDuration: number, nonce: string, asset: Asset, backends: number[], app: string) {
    const params = new Params(app, challengeDuration, nonce, [parts[0], parts[1]], true);
    const outcome = new Allocation([asset], backends, [[balances[0].toString(), balances[1].toString()]], []);
    const state = new State(params.channelID(), "0", outcome, "0x00", false);
    super(params, state);
    this.sigs = [];
  }

  async sign(parts: Participant[]) {
    let stateEncoded = this.state.encode();
    this.sigs = await Promise.all(parts.map(async participant => {
      const provider = ethers.provider;
      const signer = await provider.getSigner(participant.ethAddress);

      const messageHash = keccak256(stateEncoded);

      const messageHashBytes = getBytes(messageHash);
      return await signer.signMessage(messageHashBytes);
    }));
  }
}



export class Authorization {
  channelID: string;
  participant: Participant;
  receiver: string;
  amount: string;

  constructor(_channelID: string, _participant: Participant, _receiver: string, _amount: string) {
    this.channelID = _channelID;
    this.participant = _participant;
    this.receiver = _receiver;
    this.amount = _amount;
  }

  serialize() {
    return {
      channelID: this.channelID,
      participant: {
        ethAddress: this.participant.ethAddress,
        ccAddress: this.participant.ccAddress,
      },
      receiver: this.receiver,
      amount: this.amount
    };
  }

  encode() {
    const abiCoder = AbiCoder.defaultAbiCoder();
    return abiCoder.encode(
        [
          'tuple(bytes32 channelID, tuple(address ethAddress, bytes ccAddress) participant, address receiver, uint256 amount)'
        ],
        [
          {
            channelID: this.channelID,
            participant: {
              ethAddress: this.participant.ethAddress,
              ccAddress: this.participant.ccAddress,
            },
            receiver: this.receiver,
            amount: ethers.parseUnits(this.amount, 'wei')
          }
        ]
    );
  }
}
