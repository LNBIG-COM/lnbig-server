/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:routes:web-socket')
const WebSocketRPC = require('../class/WebSocketRPC')
const OpenChannel = require('../class/Commands/OpenChannel')
const Main = require('../class/Commands/Main')
const Chat = require('../class/Commands/Chat')
const AddMerchant = require('../class/Commands/AddMerchant')

module.exports = function (router, uri) {
    debug('router: %o, uri: %s', router, uri)
    router.all(uri, async (ctx) => {
        // Не разкомментаривать, так как иначе перестают работать сокеты
        // Я думаю, что это связано с тем, что вывод debug перенаправляется в websocket поток
        // (погуглить потом эту проблему)
        // debug('connect from ws, ctx=%o', ctx)
        try {
            new WebSocketRPC(
                ctx,
                [
                    new Main(),
                    new OpenChannel(),
                    new Chat(),
                    new AddMerchant()
                ]
            );
        } catch (e) {
            debug("Исключение в создании WebSocketRPC, message=%s", e.message)
            throw e;
        }
    });
}
