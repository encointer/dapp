import { useForm } from '@mantine/form';
import { isValidWalletAddress } from '../utils';
import {FC, useEffect, useState} from 'react';
import {Button, Grid, Stack, TextInput} from '@mantine/core';
import {createApiInstanceForNode, TNodeWithRelayChains} from '@paraspell/sdk';
import {useWallet} from "../providers/WalletProvider.tsx";
import {formatBalance} from "@polkadot/util";
import { AccountInfo } from '@polkadot/types/interfaces';
import {IntegriteeWorker} from '@encointer/worker-api';
import {Keyring} from "@polkadot/keyring";

export type FormValues = {
  from: TNodeWithRelayChains;
  to: TNodeWithRelayChains;
  currency: string;
  address: string;
  amount: number;
  useApi: boolean;
};

type Props = {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
};

const TransferForm: FC<Props> = ({ onSubmit, loading }) => {
  const { selectedAccount } = useWallet();
  const encointerApi = createApiInstanceForNode('Encointer')
  const kusamaApi = createApiInstanceForNode('Kusama')

  const [encointerBalance, setEncointerBalance] = useState<string | undefined>('loading...');
  const [kusamaBalance, setKusamaBalance] = useState<string | undefined>('loading...');

  const worker = new IntegriteeWorker('wss://scv1.paseo.api.incognitee.io:443', {
    createWebSocket: (url) => new WebSocket(url),
    types: {}
  })

  formatBalance.setDefaults({
    decimals: 12,
    unit: 'KSM',
  });

  useEffect(() => {
    if (selectedAccount) form.values.address = selectedAccount.address;
    worker.getShardVault().then((sk) => {
      console.log('Vault: ')
      console.log(sk[0])
    });
    const shard = '5wePd1LYa5M49ghwgZXs55cepKbJKhj5xfzQGfPeMS7c';
    try {
      const mrenclave = '7RuM6U4DLEtrTnVntDjDPBCAN4LbCGRpnmcTYUGhLqc7';
      let keyring = new Keyring({type: "sr25519"});
      let alice = keyring.addFromUri('//Alice', {name: 'Alice default'});
      let bob = keyring.addFromUri('//Bob', {name: 'Bob default'});

      worker.getBalance(alice, shard)
          .then((balance) => {
            console.log(`current account balance L2 for Alice: ${balance}`)
          });
      worker.getBalance(bob, shard)
          .then((balance) => {
            console.log(`current account balance L2 for Bob: ${balance}`)
          });

      // this does only call `author_submit`, so we can only know if the trusted call is valid, but we
      // can't know here if the trusted call has been executed without an error.
      worker.trustedBalanceTransfer(
          alice,
          shard,
          mrenclave,
          alice.address,
          bob.address,
          1100000000000
      ).then((hash) => console.log(`trustedOperationHash: ${hash}`));

    } catch (error) {
      console.log(`Error submitting the trusted operation: ${error}`)
    }

  }, [selectedAccount]);

  useEffect(() => {
    encointerApi.then((api) => {

      // If the user has selected an address, create a new subscription
      selectedAccount &&
      api.query.system
          .account<AccountInfo>(selectedAccount.address).then((balance: AccountInfo) =>
          {
            setEncointerBalance(formatBalance(balance.data.free))
            form.values.amount = Math.max(0, Number(balance.data.free) * Math.pow(10, -12) - 0.001)
          })
          .catch(console.error)
    })
  }, [selectedAccount, encointerApi]);

  useEffect(() => {
    kusamaApi.then((api) => {
      // If the user has selected an address, create a new subscription
      selectedAccount &&
      api.query.system
          .account<AccountInfo>(selectedAccount.address).then((balance: AccountInfo) =>
              setKusamaBalance(formatBalance(balance.data.free))
          )
          .catch(console.error)
    })
  }, [selectedAccount, kusamaApi]);

  const form = useForm<FormValues>({
    initialValues: {
      from: 'Encointer',
      to: 'Kusama',
      currency: 'KSM',
      amount: 0.2,
      address: '',
      useApi: false,
    },

    validate: {
      address: (value) => (isValidWalletAddress(value) ? null : 'Invalid address'),
    },
  });

  return (
    <form onSubmit={form.onSubmit(onSubmit)}>
      <Stack>
        <p>transferable KSM balance</p>
        <Grid>
          <Grid.Col span={6}>Encointer</Grid.Col>
          <Grid.Col span={6}>{encointerBalance}</Grid.Col>
          <Grid.Col span={6}>Kusama</Grid.Col>
          <Grid.Col span={6}>{kusamaBalance}</Grid.Col>
        </Grid>
        <TextInput label="Amount KSM to send to same account on relaychain" placeholder="0.1"
                   required {...form.getInputProps('amount')} />
        <Button type="submit" loading={loading}>
          Submit transaction
        </Button>
      </Stack>
    </form>
  );
};

export default TransferForm;
