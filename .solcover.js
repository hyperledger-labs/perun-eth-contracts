module.exports = {
    skipFiles: ['ECDSA.sol', 'SafeMath.sol'],
    client: require('ganache-cli'),
    mocha: {
        grep: "@skip-on-coverage", // Find everything with this tag.
        invert: true               // Run the grep's inverse set.
    }
};
