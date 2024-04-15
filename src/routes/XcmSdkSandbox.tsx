import { Container, Tabs, rem } from "@mantine/core";
import {
  IconSend,
} from "@tabler/icons-react";
import XcmTransfer from "../components/XcmTransfer";

const XcmSdkSandbox = () => {
  const iconStyle = { width: rem(12), height: rem(12) };

  return (
    <Tabs defaultValue="xcm-transfer">
      <Tabs.List>
        <Tabs.Tab
          value="xcm-transfer"
          leftSection={<IconSend style={iconStyle} />}
        >
          XCM Transfer
        </Tabs.Tab>
      </Tabs.List>

      <Container p="xl">
        <Tabs.Panel value="xcm-transfer">
          <XcmTransfer />
        </Tabs.Panel>

      </Container>
    </Tabs>
  );
};

export default XcmSdkSandbox;
