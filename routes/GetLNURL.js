/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const openChannelService = require('../global/openChannelService');
const debug = require('debug')('lnbig:routes:lnurl')

// Данный маршрут дёргается уже другим клиентом, например кошельком BLW для получения JSON данных для открытия канала
module.exports = function (router, uri) {
    router.get(
        uri,
        async (ctx) => {
            let uuid = ctx.query.uuid
            debug("lnurl router: uuid=%s", uuid)
            if (! /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(uuid)) {
                ctx.throw(400, 'Incorrect UUID parameter')
            }

            let res = await openChannelService.getResponseOfBalanceLock(uuid)
            if (res) {
                ctx.response.body = res
            }
            else {
                ctx.throw(400, 'Cannot make LNURL - some error')
            }
        }
    );
}
