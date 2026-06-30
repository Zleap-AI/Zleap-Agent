export * from './types.js';
export * from './config.js';
export * from './dedup.js';
export * from './runner.js';
export { BasePlatformAdapter, MAX_MESSAGE_LENGTH, SPLIT_THRESHOLD, SEND_ATTEMPTS } from './platforms/base.js';
export { FeishuAdapter, FEISHU_CHANNEL } from './platforms/feishu.js';
export { WeChatAdapter, WECHAT_CHANNEL } from './platforms/wechat/index.js';
export {
  ILinkClient,
  ILinkError,
  ILINK_BASE_URL,
  type WeixinMessage,
} from './platforms/wechat/ilink.js';
export {
  DbWeChatSessionStore,
  MemoryWeChatSessionStore,
  WECHAT_SESSION_CHANNEL,
  type WeChatSession,
  type WeChatSessionStore,
} from './platforms/wechat/session.js';
export { FeishuCliAdapter, FEISHU_CLI_CHANNEL } from './platforms/feishucli/index.js';
export {
  LarkCliClient,
  DEFAULT_CLI_BIN,
  DEFAULT_EVENT_KEY,
  type LarkBrand,
  type LarkIdentity,
  type SendInput as LarkSendInput,
} from './platforms/feishucli/cli.js';
export { ChannelSupervisor, type ChannelDescriptor } from './supervisor.js';
export {
  acceptGroupMessage,
  extractText,
  flattenPost,
  mentionsBot,
  stripMentions,
} from './platforms/feishu/normalize.js';
