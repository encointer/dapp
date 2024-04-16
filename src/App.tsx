import '@mantine/core/styles.css';
import './App.css';
import {
  MantineProvider,
  Image,
  NavLink,
  createTheme,
  MantineColorsTuple,
  Button,
  Modal,
  Stack,
} from '@mantine/core';
import { BrowserRouter, Routes, Route, NavLink as RouterNavLink } from 'react-router-dom';
import RouterTransferPage from './routes/RouterTransferPage';
import { useDisclosure } from '@mantine/hooks';
import { AppShell, Burger, Group } from '@mantine/core';
import { IconHome2 } from '@tabler/icons-react';
import { web3Accounts, web3Enable } from '@polkadot/extension-dapp';
import { InjectedAccountWithMeta } from '@polkadot/extension-inject/types';
import { useState } from 'react';
import { useWallet } from './providers/WalletProvider';
import XcmSdkSandbox from './routes/XcmSdkSandbox';

const myColor: MantineColorsTuple = [
  '#eef3ff',
  '#dce4f5',
  '#b9c7e2',
  '#94a8d0',
  '#748dc1',
  '#5f7cb8',
  '#5474b4',
  '#44639f',
  '#39588f',
  '#2d4b81'
];

const theme = createTheme({
  primaryColor: 'myColor',
  colors: {
    myColor,
  },
});

const App = () => {
  const [opened, { toggle }] = useDisclosure();
  const [modalOpened, { open: openModal, close: closeModal }] = useDisclosure(false);

  const [accounts, setAccounts] = useState<InjectedAccountWithMeta[]>([]);

  const { selectedAccount, setSelectedAccount } = useWallet();

  const initAccounts = async () => {
    const allInjected = await web3Enable('SpellRouter');

    if (!allInjected) {
      alert('No wallet extension found, install it to connect');
      throw Error('No Wallet Extension Found!');
    }

    const allAccounts = await web3Accounts();
    setAccounts(allAccounts);
  };

  const onConnectWalletClick = async () => {
    await initAccounts();
    openModal();
  };

  const onAccountSelect = (account: InjectedAccountWithMeta) => () => {
    setSelectedAccount(account);
    closeModal();
  };

  const onChangeAccountClick = async () => {
    if (!accounts.length) {
      await initAccounts();
    }
    openModal();
  };

  return (
    <BrowserRouter>
      <MantineProvider theme={theme}>
        <Modal opened={modalOpened} onClose={closeModal} title="Select account" centered>
          <Stack gap="xs">
            {accounts.map((account) => (
              <Button
                size="lg"
                variant="subtle"
                key={account.address}
                onClick={onAccountSelect(account)}
              >
                {`${account.meta.name} (${account.meta.source}) - ${account.address.replace(
                  /(.{10})..+/,
                  '$1…',
                )}`}
              </Button>
            ))}
          </Stack>
        </Modal>
          <Group h="100%" px="md" justify="space-between">
            <Image src="logo.png" w="64px" p={8} />
            {selectedAccount ? (
              <Button
                onClick={onChangeAccountClick}
                variant="outline"
              >{`${selectedAccount.meta.name} (${selectedAccount.meta.source})`}</Button>
            ) : (
              <Button onClick={onConnectWalletClick}>Connect wallet</Button>
            )}
          </Group>
          <Routes>
            <Route path="/" Component={XcmSdkSandbox} />
            <Route path="/xcm" Component={XcmSdkSandbox} />
          </Routes>
      </MantineProvider>
    </BrowserRouter>
  );
};

export default App;
