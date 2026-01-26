import { contextBridge, ipcRenderer } from 'electron';

// Expose API to renderer process
contextBridge.exposeInMainWorld('pocketAgent', {
  // Chat
  send: (message: string) => ipcRenderer.invoke('agent:send', message),
  stop: () => ipcRenderer.invoke('agent:stop'),
  onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: any) => callback(status);
    ipcRenderer.on('agent:status', listener);
    // Return cleanup function
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
  saveAttachment: (name: string, dataUrl: string) => ipcRenderer.invoke('attachment:save', name, dataUrl),
  onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { jobName: string; prompt: string; response: string }) => callback(data);
    ipcRenderer.on('scheduler:message', listener);
    return () => ipcRenderer.removeListener('scheduler:message', listener);
  },
  onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { userMessage: string; response: string; chatId: number }) => callback(data);
    ipcRenderer.on('telegram:message', listener);
    return () => ipcRenderer.removeListener('telegram:message', listener);
  },
  getHistory: (limit?: number) => ipcRenderer.invoke('agent:history', limit),
  getStats: () => ipcRenderer.invoke('agent:stats'),
  clearConversation: () => ipcRenderer.invoke('agent:clear'),

  // Facts
  listFacts: () => ipcRenderer.invoke('facts:list'),
  searchFacts: (query: string) => ipcRenderer.invoke('facts:search', query),
  getFactCategories: () => ipcRenderer.invoke('facts:categories'),
  deleteFact: (id: number) => ipcRenderer.invoke('facts:delete', id),
  getGraphData: () => ipcRenderer.invoke('facts:graph-data'),
  openFactsGraph: () => ipcRenderer.invoke('app:openFactsGraph'),
  openFacts: () => ipcRenderer.invoke('app:openFacts'),
  openCustomize: () => ipcRenderer.invoke('app:openCustomize'),

  // Customize
  getIdentity: () => ipcRenderer.invoke('customize:getIdentity'),
  saveIdentity: (content: string) => ipcRenderer.invoke('customize:saveIdentity', content),
  getIdentityPath: () => ipcRenderer.invoke('customize:getIdentityPath'),
  getInstructions: () => ipcRenderer.invoke('customize:getInstructions'),
  saveInstructions: (content: string) => ipcRenderer.invoke('customize:saveInstructions', content),
  getInstructionsPath: () => ipcRenderer.invoke('customize:getInstructionsPath'),

  // Location and timezone
  lookupLocation: (query: string) => ipcRenderer.invoke('location:lookup', query),
  getTimezones: () => ipcRenderer.invoke('timezone:list'),

  // Cron
  getCronJobs: () => ipcRenderer.invoke('cron:list'),
  createCronJob: (name: string, schedule: string, prompt: string, channel: string) =>
    ipcRenderer.invoke('cron:create', name, schedule, prompt, channel),
  deleteCronJob: (name: string) => ipcRenderer.invoke('cron:delete', name),
  toggleCronJob: (name: string, enabled: boolean) => ipcRenderer.invoke('cron:toggle', name, enabled),
  runCronJob: (name: string) => ipcRenderer.invoke('cron:run', name),
  getCronHistory: (limit?: number) => ipcRenderer.invoke('cron:history', limit),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:getAll'),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  deleteSetting: (key: string) => ipcRenderer.invoke('settings:delete', key),
  getSettingsSchema: (category?: string) => ipcRenderer.invoke('settings:schema', category),
  isFirstRun: () => ipcRenderer.invoke('settings:isFirstRun'),
  validateAnthropicKey: (key: string) => ipcRenderer.invoke('settings:validateAnthropic', key),
  validateOpenAIKey: (key: string) => ipcRenderer.invoke('settings:validateOpenAI', key),
  validateTelegramToken: (token: string) => ipcRenderer.invoke('settings:validateTelegram', token),
  restartAgent: () => ipcRenderer.invoke('agent:restart'),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  openChat: () => ipcRenderer.invoke('app:openChat'),
  startOAuth: () => ipcRenderer.invoke('auth:startOAuth'),
  completeOAuth: (code: string) => ipcRenderer.invoke('auth:completeOAuth', code),
  cancelOAuth: () => ipcRenderer.invoke('auth:cancelOAuth'),
  isOAuthPending: () => ipcRenderer.invoke('auth:isOAuthPending'),
});

// Type declarations for renderer
declare global {
  interface Window {
    pocketAgent: {
      send: (message: string) => Promise<{ success: boolean; response?: string; error?: string; tokensUsed?: number }>;
      stop: () => Promise<{ success: boolean }>;
      onStatus: (callback: (status: { type: string; toolName?: string; toolInput?: string; message?: string }) => void) => () => void;
      saveAttachment: (name: string, dataUrl: string) => Promise<string>;
      onSchedulerMessage: (callback: (data: { jobName: string; prompt: string; response: string }) => void) => () => void;
      onTelegramMessage: (callback: (data: { userMessage: string; response: string; chatId: number }) => void) => () => void;
      getHistory: (limit?: number) => Promise<Array<{ role: string; content: string; timestamp: string }>>;
      getStats: () => Promise<{ messageCount: number; factCount: number; estimatedTokens: number } | null>;
      clearConversation: () => Promise<{ success: boolean }>;
      listFacts: () => Promise<Array<{ id: number; category: string; subject: string; content: string }>>;
      searchFacts: (query: string) => Promise<Array<{ category: string; subject: string; content: string }>>;
      getFactCategories: () => Promise<string[]>;
      deleteFact: (id: number) => Promise<{ success: boolean }>;
      getGraphData: () => Promise<{
        nodes: Array<{ id: number; subject: string; category: string; content: string; group: number }>;
        links: Array<{ source: number; target: number; type: 'category' | 'semantic' | 'keyword'; strength: number }>;
      }>;
      openFactsGraph: () => Promise<void>;
      openFacts: () => Promise<void>;
      openCustomize: () => Promise<void>;
      // Customize
      getIdentity: () => Promise<string>;
      saveIdentity: (content: string) => Promise<{ success: boolean }>;
      getIdentityPath: () => Promise<string>;
      getInstructions: () => Promise<string>;
      saveInstructions: (content: string) => Promise<{ success: boolean }>;
      getInstructionsPath: () => Promise<string>;
      // Location and timezone
      lookupLocation: (query: string) => Promise<Array<{ city: string; country: string; province: string; timezone: string; display: string }>>;
      getTimezones: () => Promise<string[]>;
      getCronJobs: () => Promise<Array<{ id: number; name: string; schedule: string; prompt: string; channel: string; enabled: boolean }>>;
      createCronJob: (name: string, schedule: string, prompt: string, channel: string) => Promise<{ success: boolean }>;
      deleteCronJob: (name: string) => Promise<{ success: boolean }>;
      toggleCronJob: (name: string, enabled: boolean) => Promise<{ success: boolean }>;
      runCronJob: (name: string) => Promise<{ jobName: string; response: string; success: boolean; error?: string } | null>;
      getCronHistory: (limit?: number) => Promise<Array<{ jobName: string; response: string; success: boolean; timestamp: string }>>;
      // Settings
      getSettings: () => Promise<Record<string, string>>;
      getSetting: (key: string) => Promise<string>;
      setSetting: (key: string, value: string) => Promise<{ success: boolean }>;
      deleteSetting: (key: string) => Promise<{ success: boolean }>;
      getSettingsSchema: (category?: string) => Promise<Array<{ key: string; defaultValue: string; encrypted: boolean; category: string; label: string; description?: string; type: string }>>;
      isFirstRun: () => Promise<boolean>;
      validateAnthropicKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateOpenAIKey: (key: string) => Promise<{ valid: boolean; error?: string }>;
      validateTelegramToken: (token: string) => Promise<{ valid: boolean; error?: string; botInfo?: any }>;
      restartAgent: () => Promise<{ success: boolean }>;
      openSettings: () => Promise<void>;
      openChat: () => Promise<void>;
      startOAuth: () => Promise<{ success: boolean; error?: string }>;
      completeOAuth: (code: string) => Promise<{ success: boolean; error?: string }>;
      cancelOAuth: () => Promise<{ success: boolean }>;
      isOAuthPending: () => Promise<boolean>;
    };
  }
}
