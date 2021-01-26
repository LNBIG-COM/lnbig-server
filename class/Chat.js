/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const storage = require('node-persist');
const debug = require('debug')('lnbig:class:chat')
const clientWebSockets = require('../global/clientWebSockets');

const MAX_MESSAGES = 10

module.exports = class Chat {
    constructor() {
        debug('process.env.BASE_STORAGE_DIR=%s', `${process.env.BASE_STORAGE_DIR}/chat`)
        this.storage = storage.create({
            dir: `${process.env.BASE_STORAGE_DIR}/chat`,
            ttl: false
        });
        this.storagePromise = this.storage.init();
        this.messages = null
    }

    async load() {
        await this.storagePromise

        if (! (this.messages = await this.storage.getItem('messages')) ) {
            // Сообщения отсутствуют в кеше - создаёт свои
            this.messages = []
        }
    }

    async receivedMessage(message) {
        // Тут уже message должно быть проверено
        debug('receivedMessage: отправляем проверенное сообщение: %o', message)
        this.messages.push(message)
        if (this.messages.length > MAX_MESSAGES)
            this.messages.splice(0, this.messages.length - MAX_MESSAGES)
        this.storage.setItem('messages', this.messages)
        clientWebSockets.forEach( function () {
            try {
                debug('receivedMessage: отправка клиенту, ip: %s', this.ip)
                setImmediate(() => this.sendCommand('cmdNewMessage', { ...message }, 'chat'))
            }
            catch (e) {
                console.log('receivedMessage error: %s', e.message)
            }
        })
    }
}
