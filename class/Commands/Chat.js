/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const CaptchaCommands = require('../CaptchaCommands')
const debug = require('debug')('lnbig:class:commands:chat')
const chat = require('../../global/chat')

module.exports = class Chat extends CaptchaCommands {
    constructor() {
        debug('Chat constructor started')
        super()
        this.namespace = 'chat'; // Same namespace in client side
    }

    get captchaName () { return 'chat' }

    // cmdStartChat
    async cmdStartChat(message) {
        if (! this.reCaptchaV3) {
            this.sendCommand(message, 'cmdChatStarted', {error: "The reCaptcha v3 not resolved"})
            return
        }

        this.sendCommand(message, 'cmdChatStarted', { messages: chat.messages })
    }

    async cmdNewMessage({ nick, text }) {
        debug('cmdNewMessage: получено сообщение, но не проверено: nick: %s, text: %s', nick, text)
        if (! (typeof nick === 'string' && nick.length > 0 && nick.length < 32))
            throw new Error('nick should be from 1 to 32 length string')
        if (! (typeof text === 'string' && text.length > 0 && text.length < 255))
            throw new Error('text should be from 1 to 255 length string')
        chat.receivedMessage({nick, text})
    }
}
