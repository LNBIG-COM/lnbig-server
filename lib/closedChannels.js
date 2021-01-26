/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage, args = {cooperative: true, local_force: true, remote_force: true}) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.closedChannels(args);
    })

    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ closedChannels от ${key} получен`);
    }
    return data
}
