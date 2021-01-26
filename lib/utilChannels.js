/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

/*
* Модуль подсчёта newCapacity для ноды
*
* */
const debug = require('debug')('lnbig:newcapacity')

module.exports.newCapacity = function (nodeID, listChannels) {
    let newCapacity = 0

    for (let key in listChannels) {
        for (let channel of listChannels[key].channels) {
            if (channel.remote_pubkey === nodeID) {
                newCapacity += ( +channel.capacity / 2 - +channel.local_balance ) * 2
                debug("newCapacity (%s) текущее: %d (key: %s, %o)", nodeID, newCapacity, key, channel)
            }
        }
    }
    debug("Для узла %s получили newCapacity: %d", nodeID, newCapacity)
    return newCapacity
}

module.exports.pendingNodes = function (pendingChannels) {
    let channel, res = {}

    for (let key in pendingChannels) {
        let pc = pendingChannels[key]

        for (channel of pc.pending_open_channels) {
            if (channel.channel.local_balance > 0) {
                res[channel.channel.remote_node_pub] = res[channel.channel.remote_node_pub] || {}
                res[channel.channel.remote_node_pub][key] = Math.max(res[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
            }
        }

        for (channel of pc.pending_closing_channels) {
            if (channel.channel.local_balance > 0) {
                res[channel.channel.remote_node_pub] = res[channel.channel.remote_node_pub] || {}
                res[channel.channel.remote_node_pub][key] = Math.max(res[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
            }
        }

        for (channel of pc.pending_force_closing_channels) {
            if (channel.channel.local_balance > 0) {
                res[channel.channel.remote_node_pub] = res[channel.channel.remote_node_pub] || {}
                res[channel.channel.remote_node_pub][key] = Math.max(res[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
            }
        }

        for (channel of pc.waiting_close_channels) {
            if (channel.channel.local_balance > 0) {
                res[channel.channel.remote_node_pub] = res[channel.channel.remote_node_pub] || {}
                res[channel.channel.remote_node_pub][key] = Math.max(res[channel.channel.remote_node_pub][key] || 0, channel.channel.local_balance)
            }
        }
    }

    return res
}

module.exports.currentBlockchainBlock = function (getInfo) {
    let currentBlock = 0

    for (let key in getInfo) {
        currentBlock = Math.max(currentBlock, Number(getInfo[key].block_height))
    }

    return currentBlock
}
