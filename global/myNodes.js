/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

let myNodes = module.exports.myNodes = {}

module.exports.myNodesInit = function (nodeStorage) {
    for (let key in nodeStorage.nodes)
        myNodes[nodeStorage.nodes[key].pubKey] = key
}
