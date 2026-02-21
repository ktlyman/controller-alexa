/**
 * Types for Alexa push notification events received via the
 * WebSocket channel at dp-gw-na-js.amazon.com.
 *
 * These events arrive in real-time when devices are used, media
 * plays, connections change, etc.
 */

// ---------------------------------------------------------------------------
// Push event command types
// ---------------------------------------------------------------------------

export type PushEventCommand =
  | 'PUSH_ACTIVITY'
  | 'PUSH_CONTENT_FOCUS_CHANGE'
  | 'PUSH_DOPPLER_CONNECTION_CHANGE'
  | 'PUSH_AUDIO_PLAYER_STATE'
  | 'PUSH_VOLUME_CHANGE'
  | 'PUSH_NOTIFICATION_CHANGE'
  | 'PUSH_BLUETOOTH_STATE_CHANGE'
  | 'PUSH_MEDIA_CHANGE'
  | 'PUSH_MEDIA_PROGRESS_CHANGE'
  | 'PUSH_MEDIA_QUEUE_CHANGE'
  | 'PUSH_LIST_ITEM_CHANGE'
  | 'PUSH_EQUALIZER_STATE_CHANGE';

// ---------------------------------------------------------------------------
// Individual payload shapes
// ---------------------------------------------------------------------------

export interface DopplerId {
  deviceSerialNumber: string;
  deviceType: string;
}

export interface PushActivityPayload {
  destinationUserId?: string;
  key?: {
    entryId: string;
    registeredUserId?: string;
  };
  timestamp?: number;
}

export interface PushContentFocusPayload {
  destinationUserId?: string;
  clientId?: string;
  dopplerId?: DopplerId;
  deviceComponent?: string;
}

export interface PushConnectionChangePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  dopplerConnectionState?: 'ONLINE' | 'OFFLINE';
}

export interface PushAudioPlayerStatePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  audioPlayerState?: 'PLAYING' | 'INTERRUPTED' | 'FINISHED' | 'IDLE';
  mediaReferenceId?: string;
  error?: string;
  errorMessage?: string;
}

export interface PushVolumeChangePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  isMuted?: boolean;
  volumeSetting?: number;
}

export interface PushNotificationChangePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  eventType?: string;
  notificationId?: string;
  notificationVersion?: number;
}

export interface PushBluetoothStatePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  bluetoothEvent?: string;
  bluetoothEventPayload?: Record<string, unknown>;
  bluetoothEventSuccess?: boolean;
}

export interface PushMediaChangePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  mediaReferenceId?: string;
}

export interface PushMediaProgressPayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  progress?: {
    mediaProgress?: number;
    mediaLength?: number;
  };
  mediaReferenceId?: string;
}

export interface PushMediaQueueChangePayload {
  destinationUserId?: string;
  dopplerId?: DopplerId;
  changeType?: string;
  playBackOrder?: string;
  loopMode?: string;
}

export interface PushListItemChangePayload {
  destinationUserId?: string;
  listId?: string;
  eventName?: string;
  listItemId?: string;
}

export interface PushEqualizerStatePayload {
  destinationUserId?: string;
  bass?: number;
  midrange?: number;
  treble?: number;
}

// ---------------------------------------------------------------------------
// Unified push event
// ---------------------------------------------------------------------------

/** Raw push event as extracted from the WebSocket channel. */
export interface PushEvent {
  command: PushEventCommand | string;
  timestamp: number;
  payload: Record<string, unknown>;
  /** Extracted device serial if available (from dopplerId or key) */
  deviceSerial?: string;
  /** Extracted device type if available */
  deviceType?: string;
}

// ---------------------------------------------------------------------------
// Stored push event (for DB persistence)
// ---------------------------------------------------------------------------

/** Normalized push event for database storage. */
export interface StoredPushEvent {
  id: string;
  timestamp: string; // ISO-8601
  command: string;
  deviceSerial?: string;
  deviceType?: string;
  deviceName?: string;
  payload: Record<string, unknown>;
  processed: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket host map
// ---------------------------------------------------------------------------

export const ALEXA_PUSH_WS_HOSTS: Record<string, string> = {
  NA: 'dp-gw-na-js.amazon.com',
  EU: 'dp-gw-na.amazon.co.uk',
  FE: 'dp-gw-na.amazon.co.jp',
};

// ---------------------------------------------------------------------------
// FABE protocol constants
// ---------------------------------------------------------------------------

export const FABE = {
  GW_HANDSHAKE_CHANNEL: 0x00000361,
  GW_CHANNEL: 0x00000362,
  CHANNEL_FOR_HEARTBEAT: 0x00000065,
  DEE_WEBSITE_MESSAGING: 0x0000b479,
  MARKER: 'FABE',
  DEVICE_TYPE: 'ALEGCNGL9K0HM',
} as const;
