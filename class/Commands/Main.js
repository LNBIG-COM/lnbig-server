/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const Commands = require('../Commands')
const debug = require('debug')('lnbig:class:commands:main')
const clientStorage = require('../../global/clientStorage');
const crypto = require('crypto');

module.exports = class Main extends Commands {
    constructor() {
        debug('Main constructor started')
        super()
        this.namespace = 'main'; // Same namespace in client side
    }

    async cmdHello(message) {
        if (message.userID && /^[A-Za-z0-9\+\/\=]+$/.test(message.userID.toString())) {
            this.sendCommand(message, 'cmdYouAreUserID', {userID: await clientStorage.useOrCreateUserID(message.userID.toString())})
        } else {
            this.sendCommand(message, 'cmdYouAreUserID', {userID: await clientStorage.createUserID()})
        }
    }

    onCloseSocket() {
        debug('main: onCloseSocket()')
        super.onCloseSocket()
    }
}
