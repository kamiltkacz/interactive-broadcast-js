// @flow
import R from 'ramda';
import { setInfo, resetAlert } from './alert';
import opentok from '../services/opentok';

const setReconnecting: ActionCreator = (): BroadcastAction => ({
  type: 'SET_RECONNECTING',
  reconnecting: true,
});

const setReconnected: ActionCreator = (): BroadcastAction => ({
  type: 'SET_RECONNECTING',
  reconnecting: false,
});

const setDisconnected: ActionCreator = (): BroadcastAction => ({
  type: 'SET_DISCONNECTED',
  disconnected: true,
});

const updateStageCountdown: ActionCreator = (stageCountdown: number): BroadcastAction => ({
  type: 'UPDATE_STAGE_COUNTDOWN',
  stageCountdown,
});

const setBackstageConnected: ActionCreator = (connected: boolean): BroadcastAction => ({
  type: 'BACKSTAGE_CONNECTED',
  connected,
});

const setBroadcastEventStatus: ActionCreator = (status: EventStatus): BroadcastAction => ({
  type: 'SET_BROADCAST_EVENT_STATUS',
  status,
});

const setBroadcastState: ActionCreator = (state: CoreState): BroadcastAction => ({
  type: 'SET_BROADCAST_STATE',
  state,
});

const setPublishOnly: ActionCreator = (publishOnlyEnabled: boolean): BroadcastAction => ({
  type: 'SET_PUBLISH_ONLY_ENABLED',
  publishOnlyEnabled,
});

const setBroadcastEvent: ActionCreator = (event: BroadcastEvent): BroadcastAction => ({
  type: 'SET_BROADCAST_EVENT',
  event,
});

const onChatMessage: ThunkActionCreator = (chatId: ChatId): Thunk =>
  (dispatch: Dispatch) => {
    dispatch({ type: 'DISPLAY_CHAT', chatId, display: true });
    dispatch({ type: 'MINIMIZE_CHAT', chatId, minimize: false });
  };

const startPrivateCall: ThunkActionCreator = (participant: ParticipantType, connectToProducer?: boolean = false): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    const instance = R.equals(participant, 'backstageFan') ? 'backstage' : 'stage';
    opentok.unsubscribeAll('stage', true);
    if (connectToProducer) {
      const producerStream = opentok.getStreamByUserType(instance, 'producer');
      opentok.subscribeToAudio(instance, producerStream);
    }
    dispatch({ type: 'START_PRIVATE_PARTICIPANT_CALL', participant });
  };

const endPrivateCall: ThunkActionCreator = (participant: ParticipantType, userInCallDisconnected?: boolean = false): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    // See TODO above. We have no way of knowing who the current user is unless we pass the value around
    const instance = R.equals(participant, 'backstageFan') ? 'backstage' : 'stage';
    const currentUserInCall = R.equals(participant, R.path(['broadcast', 'inPrivateCall'], getState()));
    if (R.and(currentUserInCall, !userInCallDisconnected)) {
      opentok.subscribeAll('stage', true);
      opentok.unsubscribeFromAudio(instance, opentok.getStreamByUserType(instance, 'producer'));
    }
    dispatch({ type: 'END_PRIVATE_PARTICIPANT_CALL' });
  };

/**
 * Toggle a participants audio, video, or volume
 */
const toggleParticipantProperty: ThunkActionCreator = (participantType: ParticipantType, property: ParticipantAVProperty): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const participant = R.path(['broadcast', 'participants', participantType], getState());
    const currentValue = R.prop(property, participant);

    const update: ParticipantAVPropertyUpdate = R.ifElse(
      R.equals('volume'), // $FlowFixMe
      (): { property: 'volume', value: number } => ({ property, value: currentValue === 100 ? 50 : 100 }), // $FlowFixMe
      (): { property: 'audio' | 'video', value: boolean } => ({ property, value: !currentValue }) // eslint-disable-line comma-dangle
    )(property);
    const { value } = update;

    const to = R.path(['stream', 'connection'], participant);
    const instance = R.equals('backstageFan', participantType) ? 'backstage' : 'stage'; // For moving to OT2

    // TODO: Simplify signals
    // 1.) Make data values booleans that match the actual values
    // 2.) Create types for each action type (e.g. enableAudio, disableAudio, etc)
    switch (property) {
      case 'audio':
        opentok.signal(instance, { type: 'muteAudio', to, data: { mute: value ? 'off' : 'on' } });
        break;
      case 'video':
        opentok.signal(instance, { type: 'videoOnOff', to, data: { video: value ? 'on' : 'off' } });
        break;
      case 'volume':
        opentok.signal(instance, { type: 'changeVolume', data: { userType: participantType, volume: value ? 100 : 50 } });
        break;
      default: // Do Nothing
    }
    dispatch({ type: 'PARTICIPANT_AV_PROPERTY_CHANGED', participantType, update });
  };


const kickFanFromFeed: ThunkActionCreator = (participantType: ParticipantType): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const participant = R.path(['broadcast', 'participants', participantType], getState());
    const to = R.path(['stream', 'connection'], participant);
    const stream = R.path(['stream'], participant);
    const isStage = R.equals('fan', participantType);
    const instance = isStage ? 'stage' : 'backstage';
    const type = isStage ? 'disconnect' : 'disconnectBackstage';
    await opentok.signal(instance, { type, to });
    await opentok.unsubscribe(instance, stream);
    dispatch({ type: 'REMOVE_CHAT', chatId: participantType });
    dispatch({ type: 'BROADCAST_PARTICIPANT_LEFT', participantType });
  };

/**
 * Update the participants state when someone joins or leaves
 */
const updateParticipants: ThunkActionCreator = (participantType: ParticipantType, event: ParticipantEventType, stream: Stream): Thunk =>
  (dispatch: Dispatch, getState: GetState) => {
    switch (event) {
      case 'backstageFanLeft': {
        const participant = R.path(['broadcast', 'participants', 'backstageFan'], getState());
        if (!!participant.stream && R.equals(participant.stream.streamId, stream.streamId)) {
          dispatch({ type: 'BROADCAST_PARTICIPANT_LEFT', participantType });
        }
        break;
      }
      case 'streamCreated':
        dispatch({ type: 'BROADCAST_PARTICIPANT_JOINED', participantType, stream });
        break;
      case 'streamDestroyed':
        {
          const inPrivateCall = R.equals(participantType, R.path(['broadcast', 'inPrivateCall'], getState()));
          inPrivateCall && dispatch(endPrivateCall(participantType, true));
          dispatch({ type: 'BROADCAST_PARTICIPANT_LEFT', participantType });
          break;
        }
      case 'startCall':
        dispatch({ type: 'BROADCAST_PARTICIPANT_JOINED', participantType, stream });
        break;
      default:
        break;
    }
  };


const resetBroadcastEvent: ThunkActionCreator = (): Thunk =>
  (dispatch: Dispatch) => {
    opentok.disconnect();
    dispatch({ type: 'RESET_BROADCAST_EVENT' });
  };

/**
 * Start the go live countdown
 */
const startCountdown: ThunkActionCreator = (): Thunk =>
  async (dispatch: Dispatch): AsyncVoid => {
    const options = (counter?: number = 1): AlertPartialOptions => ({
      title: 'GOING LIVE IN',
      text: `<h1>${counter}</h1>`,
      showConfirmButton: false,
      html: true,
    });
    let counter = 5;
    const interval = setInterval(() => {
      dispatch(setInfo(options(counter)));
      if (counter >= 1) {
        counter -= 1;
      } else {
        clearInterval(interval);
        dispatch(resetAlert());
      }
    }, 1000);
  };

const publishOnly: ThunkActionCreator = (): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    const state = getState();
    const enabled = !R.path(['broadcast', 'publishOnlyEnabled'], state);
    const newBroadcastState = enabled ? opentok.unsubscribeAll('stage') : opentok.subscribeAll('stage');
    const actions = [
      setBroadcastState(newBroadcastState),
      setPublishOnly(enabled),
    ];
    R.forEach(dispatch, actions);
  };

const sendChatMessage: ThunkActionCreator = (chatId: ChatId, message: ChatMessagePartial): Thunk =>
  async (dispatch: Dispatch, getState: GetState): AsyncVoid => {
    console.log(chatId);
    console.log(getState().broadcast.chats);
    const chat: ChatState = R.path(['broadcast', 'chats', chatId], getState());
    try {
      await opentok.signal(chat.session, { type: 'chatMessage', to: chat.to.connection, data: message });
    } catch (error) {
      // @TODO Error handling
      console.log('Failed to send chat message', error);
    }
    dispatch({ type: 'NEW_CHAT_MESSAGE', chatId, message: R.assoc('isMe', true, message) });
  };

const minimizeChat: ActionCreator = (chatId: ChatId, minimize?: boolean = true): BroadcastAction => ({
  type: 'MINIMIZE_CHAT',
  chatId,
  minimize,
});

const displayChat: ActionCreator = (chatId: ChatId, display?: boolean = true): BroadcastAction => ({
  type: 'DISPLAY_CHAT',
  chatId,
  display,
});

module.exports = {
  setBroadcastState,
  setPublishOnly,
  resetBroadcastEvent,
  startCountdown,
  startPrivateCall,
  endPrivateCall,
  publishOnly,
  toggleParticipantProperty,
  setBroadcastEventStatus,
  updateParticipants,
  setBackstageConnected,
  sendChatMessage,
  kickFanFromFeed,
  minimizeChat,
  displayChat,
  onChatMessage,
  updateStageCountdown,
  setBroadcastEvent,
  setReconnecting,
  setReconnected,
  setDisconnected,
};
