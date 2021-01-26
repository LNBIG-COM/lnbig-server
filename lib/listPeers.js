/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage, args = {}) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.listPeers(args);
    })

    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ listPeers от ${key} получен`);
    }
    return data
}
