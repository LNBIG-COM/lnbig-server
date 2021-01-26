/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:class:commands')

class Commands {
    constructor() {
        debug('Commands contructor started')
        this.namespace = 'unknown';
    }

    sendCommand(prevCmd, cmdName, obj, namespace = this.namespace) {
        debug('Commands.sendCommand: uuid: %s, cmdName: %s, obj: %o, namespace: %s', prevCmd.uuid, cmdName, obj, namespace)
        obj.uuid = prevCmd.uuid
        this.parent.sendCommand(cmdName, obj, namespace)
    }

    onCloseSocket() {
        debug(`Commands/${this.namespace}/onCloseSocket`)
    }

    onOpenSocket() {
        debug(`Commands/${this.namespace}/onOpenSocket`)
    }
}

module.exports = Commands;
