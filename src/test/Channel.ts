// Copyright 2020 - See NOTICE file for copyright holders.
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

import Web3 from "web3";
declare const web3: Web3;
import { sign, hash } from "../lib/web3";

export enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

export class Channel {
  params: Params
  state: State

  constructor(params: Params, state: State) {
    this.params = params
    this.state = state
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

export class Params {
  challengeDuration: number;
  nonce: string;
  app: string;
  participants: string[];
  ledgerChannel: boolean;
  virtualChannel: boolean;

  constructor(app: string, challengeDuration: number, nonce: string, parts: string[], ledgerChannel: boolean) {
    this.app = app;
    this.challengeDuration = challengeDuration;
    this.nonce = nonce;
    this.participants = parts;
    this.ledgerChannel = ledgerChannel;
    this.virtualChannel = false;
  }

  serialize() {
    return {
      app: this.app,
      challengeDuration: this.challengeDuration,
      nonce: this.nonce,
      participants: this.participants,
      ledgerChannel: this.ledgerChannel,
      virtualChannel: this.virtualChannel,
    };
  }

  encode() {
    // Copied from "build/contracts/Adjudicator.json".
    const paramsType = {
      "components": [
        {
          "internalType": "uint256",
          "name": "challengeDuration",
          "type": "uint256"
        },
        {
          "internalType": "uint256",
          "name": "nonce",
          "type": "uint256"
        },
        {
          "internalType": "address[]",
          "name": "participants",
          "type": "address[]"
        },
        {
          "internalType": "address",
          "name": "app",
          "type": "address"
        },
        {
          "internalType": "bool",
          "name": "ledgerChannel",
          "type": "bool"
        },
        {
          "internalType": "bool",
          "name": "virtualChannel",
          "type": "bool"
        }
      ],
      "internalType": "struct Channel.Params",
      "name": "params",
      "type": "tuple"
    }
    return web3.eth.abi.encodeParameter(paramsType, this)
  }

  channelID() {
    return hash(this.encode());
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
    // Copied from "build/contracts/Adjudicator.json".
    const stateType = {
      "components": [
        {
          "internalType": "bytes32",
          "name": "channelID",
          "type": "bytes32"
        },
        {
          "internalType": "uint64",
          "name": "version",
          "type": "uint64"
        },
        {
          "components": [
            {
              "components": [
                {
                  "internalType": "uint256",
                  "name": "chainID",
                  "type": "uint256"
                },
                {
                  "internalType": "address",
                  "name": "holder",
                  "type": "address"
                }
              ],
              "internalType": "struct Channel.Asset[]",
              "name": "assets",
              "type": "tuple[]"
            },
            {
              "internalType": "uint256[][]",
              "name": "balances",
              "type": "uint256[][]"
            },
            {
              "components": [
                {
                  "internalType": "bytes32",
                  "name": "ID",
                  "type": "bytes32"
                },
                {
                  "internalType": "uint256[]",
                  "name": "balances",
                  "type": "uint256[]"
                },
                {
                  "internalType": "uint16[]",
                  "name": "indexMap",
                  "type": "uint16[]"
                }
              ],
              "internalType": "struct Channel.SubAlloc[]",
              "name": "locked",
              "type": "tuple[]"
            }
          ],
          "internalType": "struct Channel.Allocation",
          "name": "outcome",
          "type": "tuple"
        },
        {
          "internalType": "bytes",
          "name": "appData",
          "type": "bytes"
        },
        {
          "internalType": "bool",
          "name": "isFinal",
          "type": "bool"
        }
      ],
      "internalType": "struct Channel.State",
      "name": "state",
      "type": "tuple"
    };

    return web3.eth.abi.encodeParameter(stateType, this);
  }

  incrementVersion() {
    this.version = (Number(this.version) + 1).toString()
  }

  async sign(signers: string[]): Promise<string[]> {
    return Promise.all(signers.map(signer => sign(this.encode(), signer)))
  }
}

export class Asset {
  chainID: number;
  holder: string;

  constructor(_chainID: number, _holder: string) {
    this.chainID = _chainID;
    this.holder = _holder;
  }
}

export class Allocation {
    assets: Asset[];
    balances: string[][];
    locked: SubAlloc[];

    constructor(_assets: Asset[], _balances: string[][], _locked: SubAlloc[]) {
      this.assets = _assets;
      this.balances = _balances;
      this.locked = _locked;
    }

    serialize() {
      let _locked: any[] = this.locked.map(e => e.serialize());
      return { assets: this.assets, balances: this.balances, locked: _locked };
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

// TODO: Allow multiple assets
export class Transaction extends Channel {
    sigs: string[];

    constructor(parts: string[], balances: BN[], challengeDuration: number, nonce: string, asset: Asset, app: string) {
      const params = new Params(app, challengeDuration, nonce, [parts[0], parts[1]], true);
      const outcome = new Allocation([asset], [[balances[0].toString(), balances[1].toString()]], []);
      const state = new State(params.channelID(), "0", outcome, "0x00", false);
      super(params, state);
      this.sigs = [];
    }

    async sign(parts: string[]) {
      let stateEncoded = this.state.encode();
      this.sigs = await Promise.all(parts.map(participant => sign(stateEncoded, participant)));
    }
}


export class Authorization {
    channelID: string;
    participant: string;
    receiver: string;
    amount: string;

    constructor(_channelID: string, _participant: string, _receiver: string, _amount: string) {
      this.channelID = _channelID;
      this.participant = _participant;
      this.receiver = _receiver;
      this.amount = _amount;
    }

    serialize() {
      return {
        channelID: this.channelID,
        participant: this.participant,
        receiver: this.receiver,
        amount: this.amount
      };
    }

    encode() {
      return web3.eth.abi.encodeParameters(
        ['bytes32', 'address', 'address', 'uint256'],
        [
          web3.utils.rightPad(this.channelID, 64, "0"),
          this.participant,
          this.receiver,
          web3.utils.padLeft(this.amount.toString(), 64, "0")
        ]
      );
    }
  }
