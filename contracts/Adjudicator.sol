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

// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.7.0;
pragma experimental ABIEncoderV2;

import "../vendor/openzeppelin-contracts/contracts/math/SafeMath.sol";
import "./Channel.sol";
import "./App.sol";
import "./AssetHolder.sol";
import "./SafeMath64.sol";
import "./Array.sol";

/**
 * @title The Perun Adjudicator
 * @author The Perun Authors
 * @dev Adjudicator is the contract that decides on the current state of a statechannel.
 */
contract Adjudicator {
    using SafeMath for uint256;
    using SafeMath64 for uint64;

    /**
     * @dev Our state machine has three phases.
     * In the DISPUTE phase, all parties have the ability to publish their latest state.
     * In the FORCEEXEC phase, the smart contract is executed on-chain.
     * In the CONCLUDED phase, the channel is considered finalized.
     */
    enum DisputePhase { DISPUTE, FORCEEXEC, CONCLUDED }

    struct Dispute {
        uint64 timeout;
        uint64 challengeDuration;
        uint64 version;
        bool hasApp;
        uint8 phase;
        bytes32 stateHash;
    }

    /**
     * @dev Mapping channelID => Dispute.
     */
    mapping(bytes32 => Dispute) public disputes;

    /**
     * @notice Indicates that a channel has been updated.
     * @param channelID The identifier of the channel.
     * @param version The version of the channel state.
     * @param phase The dispute phase of the channel.
     * @param timeout The dispute phase timeout.
     */
    event ChannelUpdate(bytes32 indexed channelID, uint64 version, uint8 phase, uint64 timeout);

    // SignedState is a combination of params, state, and signatures.
    struct SignedState {
        Channel.Params params;
        Channel.State state;
        bytes[] sigs;
    }

    /**
     * @notice Register disputes the state of a ledger channel and its sub-channels.
     * @param channel The ledger channel to be registered.
     * @param subChannels The sub-channels in depth-first order.
     */
    function register(
        SignedState memory channel,
        SignedState[] memory subChannels
    )
    external
    {
        require(channel.params.ledgerChannel, "not ledger");
        registerRecursive(channel, subChannels, 0);
    }

    /**
     * @dev registerRecursive registers a dispute for a channel and its sub-channels.
     * It returns the accumulated outcome of the channel and its sub-channels.
     * @param channel is the main channel to be registered.
     * @param subChannels is a list of subChannels.
     * @param startIndex is the index of the first sub-channel of channel in subChannels.
     * @return outcome The accumulated outcome of the channel and its sub-channels.
     * @return nextIndex The index of the next sub-channel.
     */
    function registerRecursive(
        SignedState memory channel,
        SignedState[] memory subChannels,
        uint startIndex)
    internal
    returns (uint256[] memory outcome, uint nextIndex)
    {
        nextIndex = startIndex;
        Channel.Allocation memory alloc = channel.state.outcome;
        address[] memory assets = alloc.assets;

        // Register the channel and add the balances to outcome.
        registerSingle(channel);
        outcome = Array.accumulateUint256ArrayArray(alloc.balances);

        // For each sub-channel, register recursively and check the accumulated
        // outcome against the locked assets.
        Channel.SubAlloc[] memory locked = alloc.locked;
        require(locked.length <= subChannels.length, "subChannels: too short");
        for (uint s = 0; s < locked.length; s++) {
            SignedState memory _channel = subChannels[nextIndex++];
            (Channel.SubAlloc memory subAlloc, Channel.State memory _state) =
                (locked[s], _channel.state);
            require(subAlloc.ID == _state.channelID, "invalid sub-channel id");

            uint256[] memory _outcome;
            (_outcome, nextIndex) = registerRecursive(_channel, subChannels, nextIndex);

            Array.requireEqualAddressArray(assets, _state.outcome.assets);
            Array.requireEqualUint256Array(subAlloc.balances, _outcome);
            Array.addInplaceUint256Array(outcome, _outcome);
        }
    }

    /**
     * @dev registerSingle registers a channel dispute if the requirements are met:
     * (not registered before) or (newer version and within refutation period).
     * Registration is skipped if the channel state is already registered.
     */
    function registerSingle(
        SignedState memory channel
    )
    internal
    {
        (Channel.Params memory params, Channel.State memory state) = 
            (channel.params, channel.state);

        requireValidParams(params, state);
        Channel.validateSignatures(params, state, channel.sigs);

        if (params.virtualChannel) {
            require(!Channel.hasApp(params), "cannot have app");
            require(state.outcome.locked.length == 0, "cannot have locked funds");
        }

        // If registered, require newer version and refutation timeout not passed.
        (Dispute memory dispute, bool registered) = getDispute(state.channelID);
        if (registered) {
            if (dispute.stateHash == hashState(state)) {
                // Skip if same state.
                // This allows for refutation of related states.
                return;
            }
            require(dispute.version < state.version, "invalid version");
            require(dispute.phase == uint8(DisputePhase.DISPUTE), "incorrect phase");
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp < dispute.timeout, "refutation timeout passed");
        }

        // Write state.
        storeChallenge(params, state, DisputePhase.DISPUTE);
    }

    /**
     * @notice Progress is used to advance the state of an app on-chain.
     * If the call was successful, a Progressed event is emitted.
     *
     * @dev The caller has to provide a valid signature from the actor.
     * It is checked whether the new state is a valid transition from the old state,
     * so this method can only advance the state by one step.
     *
     * @param params The parameters of the state channel.
     * @param stateOld The previously stored state of the state channel.
     * @param state The new state to which we want to progress.
     * @param actorIdx Index of the signer in the participants array.
     * @param sig Signature of the participant that wants to progress the contract on the new state.
     */
    function progress(
        Channel.Params memory params,
        Channel.State memory stateOld,
        Channel.State memory state,
        uint256 actorIdx,
        bytes memory sig)
    external
    {
        Dispute memory dispute = requireGetDispute(state.channelID);
        if(dispute.phase == uint8(DisputePhase.DISPUTE)) {
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp >= dispute.timeout, "timeout not passed");
        } else if (dispute.phase == uint8(DisputePhase.FORCEEXEC)) {
            // solhint-disable-next-line not-rely-on-time
            require(block.timestamp < dispute.timeout, "timeout passed");
        } else {
            revert("invalid phase");
        }

        require(params.app != address(0), "must have app");
        require(actorIdx < params.participants.length, "actorIdx out of range");
        requireValidParams(params, state);
        require(dispute.stateHash == hashState(stateOld), "wrong old state");
        require(Sig.verify(Channel.encodeState(state), sig, params.participants[actorIdx]), "invalid signature");
        requireValidTransition(params, stateOld, state, actorIdx);

        storeChallenge(params, state, DisputePhase.FORCEEXEC);
    }

    /**
     * @notice conclude concludes the channel identified by params including its
     * sub-channels and sets the accumulated outcome at the assetholders.
     * The channel must be a ledger channel and not have been concluded yet.
     * Sub-channels are force-concluded if the parent channel is concluded.
     * @param params are the channel parameters.
     * @param state is the channel state.
     * @param subStates are the sub-channel states.
     */
    function conclude(
        Channel.Params memory params,
        Channel.State memory state,
        Channel.State[] memory subStates)
    external
    {
        require(params.ledgerChannel, "not ledger");
        requireValidParams(params, state);
        
        concludeSingle(state);
        (uint256[][] memory outcome,) = forceConcludeRecursive(state, subStates, 0);
        pushOutcome(state.channelID, state.outcome.assets, params.participants, outcome);
    }

    /**
     * @notice Function `concludeFinal` immediately concludes the channel
     * identified by `params` if the provided state is valid and final.
     * The caller must provide signatures from all participants.
     * Since any fully-signed final state supersedes any ongoing dispute,
     * concludeFinal may skip any registered dispute.
     * The function emits events Concluded and FinalConcluded.
     *
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param sigs Array of n signatures on the current state.
     */
    function concludeFinal(
        Channel.Params memory params,
        Channel.State memory state,
        bytes[] memory sigs)
    external
    {
        require(params.ledgerChannel, "not ledger");
        require(state.isFinal == true, "state not final");
        require(state.outcome.locked.length == 0, "cannot have sub-channels");
        requireValidParams(params, state);
        Channel.validateSignatures(params, state, sigs);

        // If registered, require not concluded.
        (Dispute memory dispute, bool registered) = getDispute(state.channelID);
        if (registered) {
            require(dispute.phase != uint8(DisputePhase.CONCLUDED), "channel already concluded");
        }

        storeChallenge(params, state, DisputePhase.CONCLUDED);
        pushOutcome(state.channelID, state.outcome.assets, params.participants, state.outcome.balances);
    }

    /**
     * @notice Calculates the channel's ID from the given parameters.
     * @param params The parameters of the channel.
     * @return The ID of the channel.
     */
    function channelID(Channel.Params memory params) public pure returns (bytes32) {
        return keccak256(Channel.encodeParams(params));
    }

    /**
     * @notice Calculates the hash of a state.
     * @param state The state to hash.
     * @return The hash of the state.
     */
    function hashState(Channel.State memory state) public pure returns (bytes32) {
        return keccak256(Channel.encodeState(state));
    }

    /**
     * @notice Asserts that the given parameters are valid for the given state
     * by computing the channelID from the parameters and comparing it to the
     * channelID stored in state.
     */
    function requireValidParams(
        Channel.Params memory params,
        Channel.State memory state)
    internal pure {
        require(state.channelID == channelID(params), "invalid params");
    }

    /**
     * @dev Updates the dispute state according to the given parameters, state,
     * and phase, and determines the corresponding phase timeout.
     * @param params The parameters of the state channel.
     * @param state The current state of the state channel.
     * @param disputePhase The channel phase.
     */
    function storeChallenge(
        Channel.Params memory params,
        Channel.State memory state,
        DisputePhase disputePhase)
    internal
    {
        (Dispute memory dispute, bool registered) = getDispute(state.channelID);
        
        dispute.challengeDuration = uint64(params.challengeDuration);
        dispute.version = state.version;
        dispute.hasApp = Channel.hasApp(params);
        dispute.phase = uint8(disputePhase);
        dispute.stateHash = hashState(state);

        // Compute timeout.
        if (state.isFinal) {
            // Make channel concludable if state is final.
            // solhint-disable-next-line not-rely-on-time
            dispute.timeout = uint64(block.timestamp);
        } else if (!registered || dispute.phase == uint8(DisputePhase.FORCEEXEC)) {
            // Increment timeout if channel is not registered or in phase FORCEEXEC.
            // solhint-disable-next-line not-rely-on-time
            dispute.timeout = uint64(block.timestamp).add(dispute.challengeDuration);
        }

        setDispute(state.channelID, dispute);
    }

    /**
     * @dev Checks if a transition between two states is valid.
     * This calls the validTransition() function of the app.
     *
     * @param params The parameters of the state channel.
     * @param from The previous state of the state channel.
     * @param to The new state of the state channel.
     * @param actorIdx Index of the signer in the participants array.
     */
    function requireValidTransition(
        Channel.Params memory params,
        Channel.State memory from,
        Channel.State memory to,
        uint256 actorIdx)
    internal pure
    {
        require(to.version == from.version + 1, "version must increment by one");
        require(from.isFinal == false, "cannot progress from final state");
        requireAssetPreservation(from.outcome, to.outcome, params.participants.length);
        App app = App(params.app);
        app.validTransition(params, from, to, actorIdx);
    }

    /**
     * @dev Checks if two allocations are compatible, e.g. if the sums of the
     * allocations are equal.
     * @param oldAlloc The old allocation.
     * @param newAlloc The new allocation.
     * @param numParts length of the participants in the parameters.
     */
    function requireAssetPreservation(
        Channel.Allocation memory oldAlloc,
        Channel.Allocation memory newAlloc,
        uint256 numParts)
    internal pure
    {
        require(oldAlloc.balances.length == newAlloc.balances.length, "balances length mismatch");
        require(oldAlloc.assets.length == newAlloc.assets.length, "assets length mismatch");
        Channel.requireEqualSubAllocArray(oldAlloc.locked, newAlloc.locked);
        for (uint256 i = 0; i < newAlloc.assets.length; i++) {
            require(oldAlloc.assets[i] == newAlloc.assets[i], "assets[i] address mismatch");
            uint256 sumOld = 0;
            uint256 sumNew = 0;
            require(oldAlloc.balances[i].length == numParts, "old balances length mismatch");
            require(newAlloc.balances[i].length == numParts, "new balances length mismatch");
            for (uint256 k = 0; k < numParts; k++) {
                sumOld = sumOld.add(oldAlloc.balances[i][k]);
                sumNew = sumNew.add(newAlloc.balances[i][k]);
            }

            require(sumOld == sumNew, "sum of balances mismatch");
        }
    }

    /**
     * @dev concludeSingle attempts to conclude a channel state.
     * Reverts if the channel is already concluded.
     */
    function concludeSingle(Channel.State memory state) internal {
        Dispute memory dispute = requireGetDispute(state.channelID);
        require(dispute.stateHash == hashState(state), "invalid channel state");
        require(dispute.phase != uint8(DisputePhase.CONCLUDED), "channel already concluded");

        // If still in phase DISPUTE and the channel has an app, increase the
        // timeout by one duration to account for phase FORCEEXEC.
        if (dispute.phase == uint8(DisputePhase.DISPUTE) && dispute.hasApp) {
            dispute.timeout = dispute.timeout.add(dispute.challengeDuration);
        }
        // solhint-disable-next-line not-rely-on-time
        require(block.timestamp >= dispute.timeout, "timeout not passed yet");
        dispute.phase = uint8(DisputePhase.CONCLUDED);

        setDispute(state.channelID, dispute);
    }

    /**
     * @dev forceConcludeRecursive forces conclusion of a channel state and its subStates.
     * @param state is the channel state.
     * @param subStates are the sub-channel states.
     * @param startIndex is the index of the first sub-channel.
     * @return outcome is the accumulated outcome of the channel and its sub-channels.
     * @return nextIndex is the index of the next sub-channel.
     */
    function forceConcludeRecursive(
        Channel.State memory state,
        Channel.State[] memory subStates,
        uint256 startIndex)
    internal
    returns (uint256[][] memory outcome, uint nextIndex)
    {
        forceConcludeSingle(state);

        // Initialize with outcome of channel.
        address[] memory assets = state.outcome.assets;
        outcome = new uint256[][](assets.length);
        for (uint a = 0; a < assets.length; a++) {
            uint256[] memory bals = state.outcome.balances[a];
            outcome[a] = new uint256[](bals.length);
            for (uint p = 0; p < bals.length; p++) {
                outcome[a][p] = state.outcome.balances[a][p];
            }
        }

        // Process sub-channels.
        nextIndex = startIndex;
        Channel.SubAlloc[] memory locked = state.outcome.locked;
        for (uint256 i = 0; i < locked.length; i++) {
            Channel.SubAlloc memory subAlloc = locked[i];
            Channel.State memory subState = subStates[nextIndex++];
            require(subAlloc.ID == subState.channelID, "invalid subchannel id");

            uint256[][] memory subOutcome;
            (subOutcome, nextIndex) = forceConcludeRecursive(subState, subStates, nextIndex);

            // Add outcome of subchannels.
            uint16[] memory indexMap = subAlloc.indexMap;
            for (uint a = 0; a < assets.length; a++) {                
                for (uint p = 0; p < indexMap.length; p++) {
                    uint256 _subOutcome = subOutcome[a][p];
                    uint16 _p = indexMap[p];
                    outcome[a][_p] = outcome[a][_p].add(_subOutcome);
                }
            }
        }
    }

    /**
     * @dev forceConcludeSingle forces conclusion of a registered channel state.
     * Reverts if the channel is not registered.
     */
    function forceConcludeSingle(Channel.State memory state) internal {
        Dispute memory dispute = requireGetDispute(state.channelID);
        require(dispute.stateHash == hashState(state), "invalid channel state");
        dispute.phase = uint8(DisputePhase.CONCLUDED);
        setDispute(state.channelID, dispute);
    }

    /**
     * @dev pushOutcome sets the outcome at the asset holders.
     */
    function pushOutcome(
        bytes32 channel,
        address[] memory assets,
        address[] memory participants,
        uint256[][] memory outcome)
    internal
    {
        for (uint a = 0; a < assets.length; a++) {
            //slither-disable-next-line calls-loop
            AssetHolder(assets[a]).setOutcome(channel, participants, outcome[a]);
        }
    }

    /**
     * @dev Returns the dispute state for the given channelID. The second return
     * value indicates whether the given channel has been registered yet.
     */
    function getDispute(bytes32 chID) internal view returns (Dispute memory, bool) {
        Dispute memory dispute = disputes[chID];
        return (dispute, dispute.stateHash != bytes32(0));
    }

    /**
     * @dev Returns the dispute state for the given channelID. Reverts if the
     * channel has not been registered yet.
     */
    function requireGetDispute(bytes32 chID) internal view returns (Dispute memory) {
        (Dispute memory dispute, bool registered) = getDispute(chID);
        require(registered, "not registered");
        return dispute;
    }

    /**
     * @dev Sets the dispute state for the given channelID. Emits event
     * ChannelUpdate.
     */
    function setDispute(bytes32 chID, Dispute memory dispute) internal {
        disputes[chID] = dispute;
        emit ChannelUpdate(chID, dispute.version, dispute.phase, dispute.timeout);
    }
}
