# dapp
A web-dapp providing some auxiliary Encointer tools

## Prerequisites

Before you begin, ensure you have met the following requirements:

- You have installed [Node.js](https://nodejs.org/en/download/)
- You have installed [pnpm](https://pnpm.io/installation)

## Installing Dependencies

To install dependencies, follow these steps:

```bash
pnpm install
```

## Using Dapp

To use Playground, follow these steps:

```bash
pnpm dev
```

This will start the development server. Open the link given during startup to access the playground.

## decentralization

### sources on radicle

Find this repo on radicle: [rad:z2LHJDLqN7P8WvWnsdnYebofKDjyT](https://radicle.network/nodes/iris.radicle.xyz/rad%3Az2LHJDLqN7P8WvWnsdnYebofKDjyT)

### deployment to IPFS

```
pnpm build
ipfs add -r --cid-version=1 dist/
```

gives you the ipfs cid like `bafybeiajpbmi4kveczt22bm5x27wahyaih6wutl5d5pyp6tdyufgjg6rua`. Publish that to IPNS:

```
ipfs name publish --key encointer bafybeiajpbmi4kveczt22bm5x27wahyaih6wutl5d5pyp6tdyufgjg6rua
```

Find the most recent published version here:
https://ipfs.io/ipns/k51qzi5uqu5diyds91yhfs9ljvrtdi3c4zk4f2ut9m16svc7bb5iccf94xr7ak

## Acknowledgements

This frontend is based on [paraspell](https://paraspell.github.io/docs/) and [polkadot api](https://polkadot.js.org/docs/api/)
