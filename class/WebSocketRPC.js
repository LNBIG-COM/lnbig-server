/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:wsrpc')
const clientWebSockets = require('../global/clientWebSockets');

class WebSocketRPC {
    constructor(ctx, controllers) {
        debug('WebSocketRPC constructor started')

        this.initSocket(ctx.websocket)
        this.sym = Symbol('wsrpc')

        this.fwdIP = ctx.request.header['x-forwarded-for'] && ctx.request.header['x-forwarded-for'].split(/\s*,\s*/)[0] || '0.0.0.0'
        this.ip    = ctx.request.header['x-real-ip']
        debug('IP адрес пользователя: real ip: %s (fwd ip: %s)', this.ip, this.fwdIP)

        this.controllers = controllers.reduce((obj, item) => {
            obj[item.namespace] = item;
            item.parent = this;
            return obj
        }, {});
        clientWebSockets.add(this)
        for (let namespace in this.controllers) {
            this.controllers[namespace].onOpenSocket();
        }
        debug('WebSocketRPC constructor: %o', this)
    }

    initSocket(ws) {
        // do something with the message from client
        this.ws = ws
        this.ws.on('message', (message) => {
            message = JSON.parse(message)
            debug('ws message: %o', message);
            debug('ws message.command: %s', message.command);
            this.dispatchMessage(message);
        })

        this.ws.on('close', () => {
            this.onCloseSocket()
        })
    }

    // { namespace: String(), command: String(), ... other data}
    dispatchMessage(message) {
        if (/^cmd\w+$/.test(message.command)
            && /^\w{2,32}$/.test(message.namespace)
            && message.namespace in this.controllers
            && message.command in this.controllers[message.namespace]
        ) {
            this.controllers[message.namespace][message.command](message);
        } else
            throw Error('command from client is not correct: ' + JSON.stringify(message))
    }

    sendCommand(cmdName, obj, namespace) {
        debug('sendCommand: cmdName: %s, namespace: %s, obj: %o', cmdName, namespace, obj)
        obj.mutation = cmdName;
        obj.namespace = namespace;
        this.ws.send(JSON.stringify(obj))
    }

    onCloseSocket() {
        debug('WebSocketRPC class, disconnect, removing from clientWebSockets')
        for (let namespace in this.controllers) {
            this.controllers[namespace].onCloseSocket();
        }
        let res = clientWebSockets.del(this)
        debug(`WebSocketRPC/onCloseSocket: the delete returned ${res}`)
    }
}

module.exports = WebSocketRPC;
