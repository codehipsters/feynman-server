
module.exports = onNewConnection;


var debug = require('debug')('app:ws-api'),
    ClientConnection = require('./client-connection'),
    store = require('./store'),
    P = require('./ws-protocol'),
    MESSAGE = P.message;


var stateByPresentationId = {},
    connectionsByClientId = {};


function onNewConnection (sockJSConn)
{
  debug('new SockJS connection: ' + sockJSConn);
  
  var conn = new ClientConnection(sockJSConn);
  conn.once(MESSAGE.inp_init, onClientInit);
}


function onClientInit (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null)
  {
    debug(`found no presentation with id ${ conn.presentationId } for client ${ conn.clientId }`);
    return conn.close(P.code.presentation_not_found);
  }

  if (conn.isPresenter)
  {
    var presenterId = presentation.presenterId;
    if (presenterId != conn.clientId)
    {
      debug(`unauthorized presenter ${ conn.clientId }`);
      return conn.close(P.code.unauthorized);
    }
    return onPresenter(conn, presentation, stateForPresentationId(presentation.id));
  }

  onClient(conn, presentation, stateForPresentationId(presentation.id));
}


function onPresenter (conn, presentation, presentationState)
{
  var { clientId } = conn;

  debug(`presenter ${ clientId } connected to presentation ${ presentation.id }`);

  presentation.setPresenterId(clientId);
  presentationState.presenter = conn;
  connectionsByClientId[ clientId ] = conn;

  // TODO: send initial state

  conn.on(MESSAGE.inp_pres_start, onPresenterStart);
  conn.on(MESSAGE.inp_pres_finish, onPresenterFinish);
  conn.on(MESSAGE.inp_pres_poll_start, onPresenterPollStart);
  conn.on(MESSAGE.inp_pres_poll_finish, onPresenterPollFinish);

  conn.once('close', onPresenterLeft);

  var initialState = {
    state: presentation.state,
    totalClients: presentation.totalClients
  };

  if (presentation.slideId != null)
  {
    initialState.slideId = presentation.slideId;
  }

  if (presentation.poll != null)
  {
    initialState.poll = presentation.poll.poll;
    initialState.pollResults = presentation.poll.results;
  }

  conn.send(MESSAGE.out_initial_state, initialState);
}


function onPresenterStart (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  presentation.start();
  broadcast(presentation, MESSAGE.out_presentation_state, presentation.state);
}


function onPresenterFinish (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  presentation.finish();
  broadcast(presentation, MESSAGE.out_presentation_state, presentation.state);
}


function onPresenterPollStart (conn, poll)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  var results = presentation.startPollAndGetEmptyResults(poll);
  notifyPresenter(presentation, MESSAGE.out_pres_poll_results, results);
  broadcast(presentation, MESSAGE.out_poll, poll);
}


function onPresenterPollFinish (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  var results = presentation.stopPoll();
  broadcast(presentation, MESSAGE.out_poll, false);
}


function onClient (conn, presentation, presentationState)
{
  var { clientId } = conn;

  debug(`client ${ clientId } connected to presentation ${ presentation.id }`);

  presentationState.connections.push(conn);
  connectionsByClientId[ clientId ] = conn;

  debug('  now total client connections:', presentationState.connections.length);

  var newTotal = presentation.addNewClientAndGetTotal(clientId);
  notifyPresenter(presentation, MESSAGE.out_pres_total_listeners, newTotal);

  conn.on(MESSAGE.inp_list_vote_up, onClientVoteUp);
  conn.on(MESSAGE.inp_list_vote_down, onClientVoteDown);
  conn.on(MESSAGE.inp_list_question, onClientQuestion);
  conn.on(MESSAGE.inp_list_poll_vote, onClientPollVote);

  conn.once('close', onClientLeft);

  var initialState = { state: presentation.state };

  var client = presentation.getClientById(clientId),
      pollWithResults;

  if (pollWithResults = presentation.poll)
  {
    initialState.poll = pollWithResults.poll;

    var pollVote = client.votesByPollId[ pollWithResults.poll.id ];
    if (pollVote >= 0)
    {
      initialState.pollVote = pollVote;
    }
  }

  conn.send(MESSAGE.out_initial_state, initialState);
}


function onClientVoteUp (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  presentation.voteUp();
  // TODO: calculate and update mood
}


function onClientVoteDown (conn)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  presentation.voteDown();
  // TODO: calculate and update mood
}


function onClientQuestion (conn, msg)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  var message = {
    type: P.message_type.inapp,
    message: msg,
    userId: conn.clientId,
  };
  presentation.addMessage(msg);
  notifyPresenter(presentation, MESSAGE.out_pres_question, msg);
}


function onClientPollVote (conn, optionIndex)
{
  var presentation = store.getPresentationById(conn.presentationId);
  if (presentation == null) return;
  var pollResults = presentation.answerPollAndGetResults(conn.clientId, optionIndex);
  pollResults && notifyPresenter(presentation, MESSAGE.out_pres_poll_results, pollResults);
}


function onPresenterLeft (conn)
{
  var { clientId, presentationId } = conn;

  debug(`presenter ${ clientId } left from presentation ${ presentationId }`);

  var presentationState = stateForPresentationId(presentationId);
  presentationState.presenter = null;
  
  cleanUpPresentationStateIfNeeded(presentationState);
}


function onClientLeft (conn)
{
  var { clientId, presentationId } = conn;

  debug(`client ${ clientId } left from presentation ${ presentationId }`);

  var presentationState = stateForPresentationId(presentationId),
      connections = presentationState.connections,
      index = connections.indexOf(conn);

  if (index >= 0)
  {
    connections.splice(index, 1);
  }
  else {
    debug(`  client ${ clientId } not found in presentation ${ presentationId }`);
  }

  debug('  now total client connections:', connections.length);

  delete connectionsByClientId[ clientId ];

  var presentation = store.getPresentationById(presentationId);
  if (presentation)
  {
    var newTotal = presentation.markClientAbsentAndGetTotal(clientId);
    notifyPresenter(presentation, MESSAGE.out_pres_total_listeners, newTotal);
  }

  cleanUpPresentationStateIfNeeded(presentationState);
}


function notifyPresenter (presentation, type, data)
{
  debug(`~> presentation ${ presentation.id } to presenter <${ type }>:`, data);

  var presenter = stateForPresentationId(presentation.id).presenter;
  if (presenter == null) return debug('   no presenter');

  presenter.send(type, data);
}


var { stringifyMessage } = ClientConnection;


function broadcast (presentation, type, data)
{
  debug(`~> presentation ${ presentation.id } broadcast <${ type }>:`, data);

  var str = stringifyMessage(type, data);
  if (str == null) return;

  var { connections } = stateForPresentationId(presentation.id),
      totalConnections = connections.length;

  debug(`   total ${ totalConnections } connections`);

  for (var i = 0; i < totalConnections; ++i)
  {
    connections[i].write(str);
  }
}


function stateForPresentationId (presentationId)
{
  var state = stateByPresentationId[ presentationId ];
  if (state == null)
  {
    stateByPresentationId[ presentationId ] = state = 
    {
      presentationId: presentationId,
      presenter: null,
      connections: []
    };
    debug(`created an empty state for presentation with id ${ presentationId }`);
  }
  return state;
}


function cleanUpPresentationStateIfNeeded (presentationState)
{
  if (presentationState.presenter == null && presentationState.connections.length == 0)
  {
    delete stateByPresentationId[ presentationState.presentationId ];
    debug(`removed empty state for presentation with id ${ presentationState.presentationId }`);
  }
}
