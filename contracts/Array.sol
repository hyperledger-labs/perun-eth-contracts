// Copyright 2021 - See NOTICE file for copyright holders.
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

pragma solidity ^0.8.0;

import "../vendor/openzeppelin-contracts/contracts/math/SafeMath.sol";

/// @notice Array is a library for array operations.
library Array {
    using SafeMath for uint256;

    /// @dev Asserts that a and b are equal.
    function requireEqualUint16Array(
        uint16[] memory a,
        uint16[] memory b
    )
    internal pure
    {
        require(a.length == b.length, "uint16[]: unequal length");
        for (uint i = 0; i < a.length; i++) {
            require(a[i] == b[i], "uint16[]: unequal item");
        }
    }
    
    /// @dev Asserts that a and b are equal.
    function requireEqualAddressArray(
        address[] memory a,
        address[] memory b
    )
    internal
    pure
    {
        require(a.length == b.length, "address[]: unequal length");
        for (uint i = 0; i < a.length; i++) {
            require(a[i] == b[i], "address[]: unequal item");
        }
    }

    /// @dev Asserts that a and b are equal.
    function requireEqualUint256Array(
        uint256[] memory a,
        uint256[] memory b
    )
    internal pure
    {
        require(a.length == b.length, "uint256[]: unequal length");
        for (uint i = 0; i < a.length; i++) {
            require(a[i] == b[i], "uint256[]: unequal item");
        }
    }

    /// @dev Computes a += b.
    /// Assumes a.length == b.length.
    function addInplaceUint256Array(
        uint256[] memory a,
        uint256[] memory b
    )
    internal pure
    {
        for (uint i = 0; i < a.length; i++) {
            a[i] = a[i].add(b[i]);
        }
    }

    /// @dev Takes as input a 2-dimensional array of unsigned integers, a, and
    /// outputs a 1-dimensional array, b, where b[i] = sum(a[i]).
    function accumulateUint256ArrayArray(
        uint256[][] memory a
    )
    internal pure
    returns (uint256[] memory b)
    {
        b = new uint256[](a.length);
        for (uint i = 0; i < a.length; i++) {
            uint256[] memory _a = a[i];
            for (uint j = 0; j < _a.length; j++) {
                b[i] = b[i].add(_a[j]);
            }
        }
    }
}
