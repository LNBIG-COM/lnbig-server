/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const openChannelService = require('../global/openChannelService');
const debug = require('debug')('lnbig:routes:open-channel')

// Это второй шаг, который дёргается клиентом, например BLW, после того, как сделан коннект на ноду, выданную на первом шаге (./GetLNURL)
module.exports = function (router, uri) {
    router.get(
        uri,
        async (ctx) => {
            debug("Поступил запрос /oc, query: %o", ctx.query)

            try {
                // k1 parameter
                let uuid = ctx.query.k1
                if (! /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(uuid)) {
                    throw new Error('The k1 parameter is not correct')
                }
                uuid = String(uuid)

                // remoteid - публичный ключ (66 hex символов)
                let remoteID = ctx.query.remoteid
                if (! /^[0-9a-f]{66}$/i.test(remoteID)) {
                    throw new Error('The remoteid should be exactly 66 letters (left zero padding)')
                }
                remoteID = String(remoteID)

                // private - 1 или 0
                let privateChannel = ctx.query.private
                if (! /^1|0$/i.test(privateChannel)) {
                    throw new Error('The private should be 1 or 0')
                }
                privateChannel = privateChannel == 1

                try {
                    debug("Все поля корректны, проверяем и открываем канал (%s, %s, %s)", uuid, remoteID, privateChannel)

                    // Если находим клиента с таким веб-сокетом - посылаем туда команду на изменения статуса открытия
                    let ws = openChannelService.wsClientByUUID(uuid)
                    ws && ws.sendCommand('setCurrentStageIndexByWS', { openChannelProgressIndex: 6 }, 'openChannel')

                    let res = await openChannelService.openChannelByCallback(uuid, remoteID, privateChannel)

                    // Если мы здесь, то необязательно успех, может быть и ошибка
                    debug("Открытие канала, ответ: %o", res)
                    ctx.response.body = res
                }
                catch (e) {
                    console.log("Открытие канала - непридвиденная ошибка! Запрос %o, ошибка %s", ctx.query, e.message)
                    throw new Error('Server error! We are already researching this one!')
                }
            }
            catch (e) {
                ctx.response.body = { status: "ERROR", reason: e.message};
            }
        }
    );
}
