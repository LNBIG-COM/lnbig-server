# Balance-Oriented Autopilot

## Preamble

I want to bring to your attention the autopilot algorithm, built on simple principles, but which is effective (from my point of view). There is no need to qualify network nodes by types such as for example: Merchant, Router, Useless (i used Vampire term) and so on. The algorithm is very simple and here is its description.

## Description

1. With some nodes we already have channels. We need to decide when we need to open new channels and with what capacity. **We get a list of already open channels** and **create counters (accumulators)** (`newCapacity`) with zero initialization for each node with which we have a channel.

2. We pass through each node and **look at each channel and count**:

        newCapacity = newCapacity + (channelCapacity / 2 - localBalance) * 2

    Thus we consider the accumulative sum in satoshis of _how much capacity we lack to the middle of the channel_ and multiply it by two.

    It turns out that if we have many depleted channels (localBalance &lt; 1/2 of capacity), our accumulator will increase. If we have more channels that are deposited on our part the counter will decrease and can easily go into the negative. If we have many balanced channels with a node, the counter will be near zero
    
3. After passing all the nodes for each node, we will have accumulated counters (`newCapacity`). **The counter (accumulator) value is the volume of the future channel capacity with this node that we need to create.** If the counter is less than zero the channel will not be created. If more we can apply the threshold (open/not open) of the channel. For example we open a channel only if the amount is above 5,000,000 satoshis.

4. Also in the implementation of the algorithm, it is necessary **to take into account the condition** that if we have _pending channels_ with the node we exclude the creation of a channel with this node in this cycle.

5. After a while we repeat the cycle from point 1

## Scenarios

Consider some scenarios that may arise. The term **A** will be our node or pool of nodes. Other remote node will be **B**

1. We have two channels that both are open by us (or created by the opposite node but it made payments in our direction):

        A <******************|-----> B
        A <********************|---> B


    In this situation the accumulator will be clearly less than zero - no new channel is required.
    
2. We have two channels - one is a little exhausted, the other is a bit crowded.
     
        A <********|---------------> B
        A <********************|---> B

    In this situation, the accumulator will be a value of about +/- zero. Channel creation is not required, as it will be below the threshold.

3. We have two channels and both are exhausted. For example, such a situation may arise if we have opening channels to a merchant site that “consumes” payments.

        A <****|-------------------> B
        A <******|-----------------> B

    Here, the accumulator will obviously have a value comparable to one of the channels. There will be opened the channel.

    This is what we need - if the node consumes it is beneficial for us to open a new channel on it. In the next iteration of the algorithm, the accumulator will be again near zero until the third channel is exhausted. After that a new channel will be opened again, etc.
    
4. If we do not have a channel with any node the algorithm will not open the channel. But here you can add some signals to the algorithm. For example, at the initial moment of launch the node operator opens the channels himself to large merchant/router nodes. Or the second scenario - third-party nodes can open a channel on us (see the following item).

5. If someone opens a channel for us, then the algorithm will prescribe to open a channel for it with the same capacity. It is also good for us.

6. If we have balanced channels with a node, the opening of new channels will not take place until one of them is exhausted.

## Conclusion

The LNBIG project will test this algorithm already today. Preliminary debugging showed that it is well attaining the objectives of the project. [The JavaScript code is here](https://gist.github.com/LNBIG-COM/bc415ee3e381b17487c4c955945e5ef4).

Author: _**LNBIG owner**_
