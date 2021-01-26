// This is the example file of all nodes info
// This file to be made by makefile which will be published later
// A macaroon files to be encrypted (by makefile) at lnd servers by this was:
// openssl aes-256-cbc -pbkdf2 -A -a -salt -in admin.macaroon -out admin.macaroon.crypted.txt
// The SSL certificates for gRPC are base64 encoded. Here are only examples
module.exports = {
    "lnd-01": { pubKey: '0390b5d4492dc2f5318e5233ab2cebf6d48914881a33ef6a9c6bcdbb433ad986d0', internalHost: 'AH01', cert: 'LS0tLS1CRUdJT...T0KLS0tLS1FTkQgQ0VSVS0tLQo=', macaroon: 'U2FsdGVkX...sdTslw69L2eMYzhOOU1w=='},
    "lnd-02": { pubKey: '03d37fca0656558de4fd86bbe490a38d84a46228e7ec1361801f54f9437a18d618', internalHost: 'AH02', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...yNXrJBdQ1CvyxJRc+ucw=='},
    "lnd-03": { pubKey: '032679fec1213e5b0a23e066c019d7b991b95c6e4d28806b9ebd1362f9e32775cf', internalHost: 'AH03', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...XbQc/Sq3H+welCtOjWyw=='},
    "lnd-05": { pubKey: '031ce29116eab7edd66148f5169f1fb658fad62bdc5091221ab895fe5d36db00b2', internalHost: 'AH05', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...S/Tzl4YRpeeZEydP3eZQ=='},
    "lnd-06": { pubKey: '03bc9337c7a28bb784d67742ebedd30a93bacdf7e4ca16436ef3798000242b2251', internalHost: 'AH06', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...Qux2ZW5GIUUQzlpwiv1g=='},
    "lnd-07": { pubKey: '03da1c27ca77872ac5b3e568af30673e599a47a5e4497f85c7b5da42048807b3ed', internalHost: 'AH07', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...9+qCPpf4OXcV+MvjGbmw=='},
    "lnd-09": { pubKey: '02de11c748f5b25cfd2ce801176d3926bfde4de23b1ff43e692a5b76cf06805e4a', internalHost: 'AH09', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...2yrq+1tOEePmn84oPE+Q=='},
    "lnd-10": { pubKey: '02bb24da3d0fb0793f4918c7599f973cc402f0912ec3fb530470f1fc08bdd6ecb5', internalHost: 'AH10', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...zM/N96ZgquwmMWaIX2Eg=='},
    "lnd-11": { pubKey: '033e9ce4e8f0e68f7db49ffb6b9eecc10605f3f3fcb3c630545887749ab515b9c7', internalHost: 'AH11', cert: 'LS0tLS1CRUdJT...CBDRVJUSUZJQ0FURS0tLS0tCg==', macaroon: 'U2FsdGVkX...0bqNMRtZ2LKV+HCLg/kQ=='},
    "lnd-12": { pubKey: '034ea80f8b148c750463546bd999bf7321a0e6dfc60aaf84bd0400a2e8d376c0d5', internalHost: 'AH12', cert: 'LS0tLS1CRUdJT...CBDRVJUSUZJQ0FURS0tLS0tCg==', macaroon: 'U2FsdGVkX...lJWPubS+Ulikb4OKPO8w=='},
    "lnd-13": { pubKey: '035f5236d7e6c6d16107c1f86e4514e6ccdd6b2c13c2abc1d7a83cd26ecb4c1d0e', internalHost: 'AH13', cert: 'LS0tLS1CRUdJT...CBDRVJUSUZJQ0FURS0tLS0tCg==', macaroon: 'U2FsdGVkX...MP18d1hExvTn5vKGKrAQ=='},
    "lnd-17": { pubKey: '03fb822818be083e0a954db85257a2911a3d55458b8c1ea4124b157e865a836d12', internalHost: 'AH17', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...LptUVZ/kyMtOqjckbjeA=='},
    "lnd-21": { pubKey: '02c91d6aa51aa940608b497b6beebcb1aec05be3c47704b682b3889424679ca490', internalHost: 'AH21', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...Hl+7EgulQTFLYhyuAEog=='},
    "lnd-25": { pubKey: '0303a518845db99994783f606e6629e705cfaf072e5ce9a4d8bf9e249de4fbd019', internalHost: 'AH25', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...1tcE4X5p9XOWrkUMEzaw=='},
    "lnd-26": { pubKey: '02247d9db0dfafea745ef8c9e161eb322f73ac3f8858d8730b6fd97254747ce76b', internalHost: 'AH26', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...IX6T05sn42zjafyC1rLw=='},
    "lnd-27": { pubKey: '03fce165537aea120bffe8505876b44d5119354f825b3eac329b761fc5636bf334', internalHost: 'AH27', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...mPVSLBjm/WX8WwzlfRVg=='},
    "lnd-28": { pubKey: '030995c0c0217d763c2274aa6ed69a0bb85fa2f7d118f93631550f3b6219a577f5', internalHost: 'AH28', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...vCIKpVj/aneVvZxxzN3Q=='},
    "lnd-31": { pubKey: '03e5ea100e6b1ef3959f79627cb575606b19071235c48b3e7f9808ebcd6d12e87d', internalHost: 'AH31', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...289FSg563M2XFd6cWI2A=='},
    "lnd-32": { pubKey: '039edc94987c8f3adc28dab455efc00dea876089a120f573bd0b03c40d9d3fb1e1', internalHost: 'AH32', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...k9DXZ/dZ2zQoMDFPZ3Qg=='},
    "lnd-33": { pubKey: '028a8e53d70bc0eb7b5660943582f10b7fd6c727a78ad819ba8d45d6a638432c49', internalHost: 'AH33', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...mBbdd3HssDeAzLwJFvOA=='},
    "lnd-34": { pubKey: '022755c3ff4e5a1d71f573cda4b315887fc00a9e5c9ea9a847d939f3e517e69a70', internalHost: 'AH34', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...zGzBWfIpum/c0pcUuJrw=='},
    "lnd-37": { pubKey: '022c260f9ad58196af280c80a96ec9eabf6404df59ff1a7553b0f381c875a29ba0', internalHost: 'AH37', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...x/5tLGnTPhBpmwy6/rQA=='},
    "lnd-38": { pubKey: '024d2387409269f3b79e2708bb39b895c9f4b6a8322153af54eba487d4993bf60f', internalHost: 'AH38', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...EdfPj/qxqpZq9WKqpE3A=='},
    "lnd-41": { pubKey: '03dab87ff8635982815c4567eb58af48f9944d11c56beb12b91e1049aaea06e187', internalHost: 'AH41', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...g7V1EOa0GCLmD3l3WFGg=='},
    "lnd-42": { pubKey: '0311cad0edf4ac67298805cf4407d94358ca60cd44f2e360856f3b1c088bcd4782', internalHost: 'AH42', cert: 'LS0tLS1CRUdJT...U5EIENFUlRJRklDQVRFLS0tLS0K', macaroon: 'U2FsdGVkX...sqIthC5J9sWx89KDyi+A=='},
}
