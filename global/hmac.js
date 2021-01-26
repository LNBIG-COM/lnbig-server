/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = () => require('crypto').createHmac('sha256', process.env.HMAC_SECRET)
