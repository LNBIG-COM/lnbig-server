/*
 * Copyright (c) 2019 LNBIG.com
 * All rights reserved.
 */

module.exports = async function (nodeStorage, opts = {start_time: 0, end_time: 0, index_offset: 0, num_max_events: 0}) {
    let data = {};
    Object.values(nodeStorage.nodes).map(item => {
        let {key, client} = item;
        if (client)
            data[key] = client.forwardingHistory(opts);
    })

    for (let key in data) {
        data[key] = await data[key];
        console.log(`Ответ forwardingHistory от ${key} получен`);
    }
    return data
}
