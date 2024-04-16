import { useForm } from '@mantine/form';
import { isValidWalletAddress } from '../utils';
import {FC, useEffect} from 'react';
import { Button, Stack, TextInput } from '@mantine/core';
import { TNodeWithRelayChains } from '@paraspell/sdk';
import {useWallet} from "../providers/WalletProvider.tsx";

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

  useEffect(() => {
    if (selectedAccount) form.values.address = selectedAccount.address;
  }, [selectedAccount]);

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
        <TextInput label="Amount KSM to send to same account on relaychain" placeholder="0.1" required {...form.getInputProps('amount')} />
        <Button type="submit" loading={loading}>
          Submit transaction
        </Button>
      </Stack>
    </form>
  );
};

export default TransferForm;
