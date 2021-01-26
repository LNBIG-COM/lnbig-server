/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = (opts = {}) => Object.assign(opts, {
        host:'localhost',
        supportBigNumbers: true,
        bigNumberStrings: true,
        charset: 'utf8mb4',
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_USER
})
