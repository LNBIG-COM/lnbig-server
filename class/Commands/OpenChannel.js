/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const CaptchaCommands = require('../CaptchaCommands')
const debug = require('debug')('lnbig:class:commands:openchannel')
const openChannelService = require('../../global/openChannelService');
const bech32 = require('bech32');

module.exports = class OpenChannel extends CaptchaCommands {
    constructor() {
        debug('OpenChannel constructor started')
        super()
        this.namespace = 'openChannel'; // Same namespace in client side
        this.balanceLock = null // Здесь будет локировка, если клиент находится в стадии открытия канала
    }

    get captchaName () { return 'openChannelWizard' }

    getLNURL(lock) {
        let url = `${process.env.BASE_API_URL}/lnurl?uuid=${lock.uuid}`
        debug("getLNURL: url is %s", url)
        return bech32.encode('lnurl', bech32.toWords(Buffer.from(url, 'utf8')), 1024)
    }

    async onCloseSocket() {
        if (openChannelService.lockClients.bySym[this.parent.sym]) {
            debug('Удаляем WSRPC объект для UUID блокировки %s', openChannelService.lockClients.bySym[this.parent.sym])
            delete openChannelService.lockClients.byUUID[openChannelService.lockClients.bySym[this.parent.sym]]
            delete openChannelService.lockClients.bySym[this.parent.sym]
        }
        // // TODO может и удалить этот код - тогда локировка будет привязана только ко времени, а не к сокету
        // if (this.balanceLock) {
        //     await openChannelService.releaseFreeBalanceLock(this.balanceLock)
        //     this.balanceLock = null
        // }
        super.onCloseSocket();
    }

    // Открытие канала методом LNURL, например BLW кошельком
    async cmdGetOpenChannelLnurl(message) {
        if (! this.reCaptchaV3 && ! this.reCaptchaV2) {
            this.sendCommand(message, 'cmdOpenChannelLnurlResult', {error: "The reCaptcha was not resolved"})
            return
        }

        if (! (this.ocrLock = await openChannelService.createOpenChannelRequest())) {
            this.sendCommand(message, 'cmdOpenChannelLnurlResult', {error: "Service doesn't work properly. Please repeat later!"})
            return
        }

        // Здесь у нас есть блокировка, а значит её uuid - связываем блокировку с веб-сокетом клиента, чтобы отправлять ему сообщения
        openChannelService.lockClients.byUUID[this.ocrLock.uuid] = this.parent.sym
        openChannelService.lockClients.bySym[this.parent.sym] = this.ocrLock.uuid

        this.sendCommand(message, 'cmdOpenChannelLnurlResult', {lnurl: this.getLNURL(this.ocrLock)})
    }

    // Открытие канала методом API, например коннект из LND
    async cmdGetOpenChannelApi(message) {
        if (! this.reCaptchaV3 && ! this.reCaptchaV2) {
            this.sendCommand(message, 'cmdOpenChannelApiResult', {error: "The reCaptcha was not resolved"})
            return
        }

        if (! (this.ocrLock = await openChannelService.createOpenChannelRequest())) {
            this.sendCommand(message, 'cmdOpenChannelApiResult', {error: "Service doesn't work properly. Please repeat later!"})
            return
        }

        // Здесь у нас есть блокировка, а значит её uuid - связываем блокировку с веб-сокетом клиента, чтобы отправлять ему сообщения
        openChannelService.lockClients.byUUID[this.ocrLock.uuid] = this.parent.sym
        openChannelService.lockClients.bySym[this.parent.sym] = this.ocrLock.uuid

        // Посылаем на клиент статус, что ждёт открытия канала
        this.parent.sendCommand('setCurrentStageIndexByWS', { openChannelProgressIndex: 6 }, 'openChannel')

        this.sendCommand(message, 'cmdOpenChannelApiResult', {api})
    }
}
