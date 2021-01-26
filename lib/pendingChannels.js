/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.pendingChannels({});
    })

    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ pendingChannels от ${key} получен`);
    }
    return data;
}
