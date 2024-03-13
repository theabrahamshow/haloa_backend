const crypto = require('crypto')

// Generating a 256-bit (32 bytes) key
const hmacSecretKey = crypto.randomBytes(32).toString('hex')
console.log(hmacSecretKey)
