/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

const debug = require('debug')('lnbig:clws')

class ClientWebSockets {
    constructor () {
        this.storage = {}
    }

    noop() {}

    add(wsrpc) {
        let data = this.storage[wsrpc.sym] = {
            wsrpc,
            isAlive: true
        }

        wsrpc.ws.on('pong', () => {
            debug('Получили pong от клиента, ip: %s', data.wsrpc.ip)
            data.isAlive = true
        })

        wsrpc.ws.on('close', () => {
            data.isAlive = false
            this.onCloseSocket(data)
        })

        data.pingInterval = setInterval(() => {
            if (data.isAlive === false) {
                debug('Клиент (ip %s) не ответил на два периода ping, закрываем!', data.wsrpc.ip)
                data.wsrpc.ws.terminate()
                return
            }

            data.isAlive = false
            debug('Послали ping до клиента, ip: %s', data.wsrpc.ip)
            data.wsrpc.ws.ping(this.noop)
        }, 30000)
    }

    find(sym) {
        return this.storage[sym] && this.storage[sym].isAlive && this.storage[sym].wsrpc
    }

    forEach(cb) {
        Object.getOwnPropertySymbols(this.storage).forEach((sym) => {
            try {
                cb.call(this.storage[sym].wsrpc, this.storage[sym])
            }
            catch (e) {
                console.log('forEachWSRPC, error (ip: %s): %s', this.storage[sym].wsrpc.ip, e.message)
            }
        })

    }

    onCloseSocket(data) {
        if (data.pingInterval) {
            debug('Завершаем сокет клиента (ip %s), очищаем таймеры ping/pong', data.wsrpc.ip)
            clearInterval(data.pingInterval)
            data.pingInterval = null
        }
    }

    del(wsrpc) {
        return delete this.storage[wsrpc.sym]
    }
}

module.exports = new ClientWebSockets(); // opened websockets
