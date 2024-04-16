import { useForm } from '@mantine/form';
import { isValidWalletAddress } from '../utils';
import {FC, useEffect, useState} from 'react';
import {Button, Grid, Stack, TextInput} from '@mantine/core';
import {createApiInstanceForNode, TNodeWithRelayChains} from '@paraspell/sdk';
import {useWallet} from "../providers/WalletProvider.tsx";
import {formatBalance} from "@polkadot/util";

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

  const [encointerBalance, setEncointerBalance] = useState();
  const [kusamaBalance, setKusamaBalance] = useState();

  formatBalance.setDefaults({
    decimals: 12,
    unit: 'KSM',
  });

  useEffect(() => {
    if (selectedAccount) form.values.address = selectedAccount.address;
  }, [selectedAccount]);

  useEffect(() => {
    let unsubscribe
    encointerApi.then((api) => {
      // If the user has selected an address, create a new subscription
      selectedAccount &&
      api.query.system
          .account(selectedAccount.address, balance =>
          {
            setEncointerBalance(formatBalance(balance.data.free))
            form.values.amount = Math.max(0, balance.data.free * Math.pow(10, -12) - 0.001)
          }
          )
          .then(unsub => (unsubscribe = unsub))
          .catch(console.error)
      return () => unsubscribe && unsubscribe()
    })
  }, [selectedAccount, encointerApi]);

  useEffect(() => {
    let unsubscribe
    if (selectedAccount) form.values.address = selectedAccount.address;
    kusamaApi.then((api) => {
      // If the user has selected an address, create a new subscription
      selectedAccount &&
      api.query.system
          .account(selectedAccount.address, balance =>
              setKusamaBalance(formatBalance(balance.data.free))
          )
          .then(unsub => (unsubscribe = unsub))
          .catch(console.error)
      return () => unsubscribe && unsubscribe()
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
