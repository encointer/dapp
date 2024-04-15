import { useForm } from '@mantine/form';
import { isValidWalletAddress } from '../utils';
import { FC } from 'react';
import { Button, Stack, TextInput } from '@mantine/core';
import { TNodeWithRelayChains } from '@paraspell/sdk';
import {useWallet} from "../providers/WalletProvider.tsx";

export type FormValues = {
  from: TNodeWithRelayChains;
  to: TNodeWithRelayChains;
  currency: string;
  address: string;
  amount: string;
  useApi: boolean;
};

type Props = {
  onSubmit: (values: FormValues) => void;
  loading: boolean;
};

const TransferForm: FC<Props> = ({ onSubmit, loading }) => {
  const { selectedAccount } = useWallet();
  const form = useForm<FormValues>({
    initialValues: {
      from: 'Encointer',
      to: 'Kusama',
      currency: 'KSM',
      amount: '0.2',
      address: selectedAccount? selectedAccount.address : '',
      useApi: false,
    },

    validate: {
      address: (value) => (isValidWalletAddress(value) ? null : 'Invalid address'),
    },
  });

  const isNotParaToPara =
    form.values.from === 'Polkadot' ||
    form.values.from === 'Kusama' ||
    form.values.to === 'Polkadot' ||
    form.values.to === 'Kusama';

  return (
    <form onSubmit={form.onSubmit(onSubmit)}>
      <Stack>
        {!isNotParaToPara && (
          <TextInput
            label="Currency"
            placeholder="GLMR"
            required
            {...form.getInputProps('currency')}
          />
        )}

        <TextInput
          label="Recipient address on relaychain"
          placeholder="0x0000000"
          required
          {...form.getInputProps('address')}
        />

        <TextInput label="Amount KSM to send" placeholder="0.1" required {...form.getInputProps('amount')} />

        <Button type="submit" loading={loading}>
          Submit transaction
        </Button>
      </Stack>
    </form>
  );
};

export default TransferForm;
