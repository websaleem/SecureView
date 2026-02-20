// import other files
importScripts('./svdb.js', './svutils.js');

// set the default browser name
var browserName = 'Google Chrome';

try {
	// update the browser name based on brand
	if(navigator.userAgentData.brands.length > 0)
	{
		// set for Microsoft edge
		browserName = navigator.userAgentData.brands[1].brand;
		
		trace_log('Browser name: ' + browserName);
	}
} catch (err) {
	// exception 
	trace_log('Failed to get the browser name, use default. Error ' + err, true);
}

// Load local storage everytime background script runs
chrome.storage.local.get().then((items) => {
	// load uid value
	if(items["uid"] != undefined)
		strUidValue = items["uid"];
	
	// load last status timestamp
	if(items["lastpingtime"] != undefined)
		nLastPingTime = items["lastpingtime"];
});


async function StoreMessage(message)
{
	// add browser type and timestamp to each message
	message.browser_name = browserName;

	message.timestamp = new Date().getTime();

	trace_log('StoreMessage' + JSON.stringify(message));
}

// send message when a window is created
function onWindowCreated(Window) 
{
  
}

// send message when a window is removed
function onWindowRemoved(WindowId) 
{

}

// function will reload extension immediately.
function onUpdateReload()
{
	// reload the extension
	chrome.runtime.reload();
}

// function handling messages
function onMessageClient(message)
{
	// process the messages based on message type
	switch(message.message_type)
	{
		// handle the config response
		case 'response_config':
		{
			if(message.enabled_debug)
				bLogEnabled = message.enabled_debug;

			if(strUidValue === '' && typeof message.uid != undefined)
			{
				strUidValue = message.uid;
				chrome.storage.local.set({ "uid": strUidValue }).then(() => {
					trace_log('uid ' + strUidValue + ' stored in the local strorage.');
				});
			}

			if(message.enabled)
				
			
			trace_log('onMessageClient: RESPONSE_CONFIG ' + JSON.stringify(message) );
			
			// process extension status ping
			processExtensionStatusPing();

			break;
		}
		// this sets the uninstall url, if user manually uninstall extensions, this will be opened
		case 'uninstall_url':
		{
			trace_log('onMessageClient: SET_UNINSTALL_URL. Message ' + + JSON.stringify(message));
			if(message.uninstall_url != 'undefined')
				chrome.runtime.setUninstallURL({url: message.uninstall_url});
		}
		// send any other messages directly to server
		default: 
		{
			trace_log('onMessageClient: Received unknown message type ' + message.message_type, true);
		}
	}
}

// function handling messages from content script
function onMessageHandler(request, sender, sendResponse)
{
	if((sender.tab == undefined || sender.tab.id == chrome.tabs.TAB_ID_NONE) && sender.id != chrome.runtime.id)
	{
		sendResponse(true);
		return;
	}

	// process the messages based on message type
	switch(request.message_type)
	{
		// handling get config request
		case 'request_config':
		{
			// config request by content script
			var message = new Object();
			message.bLogEnabled = bLogEnabled;
			
			sendResponse(message);
			return;
		}
		// handling process specifics related to page_data 
		case 'page_load':
		{
			// check if its main frame
			if(sender.frameId == 0)
			{
				// add tab info
				request.tab_id = sender.tab.id;
				request.frame_id = sender.frameId;
				request.document_id = sender.documentId;

				// set is_complete true.
				request.is_complete = true;

				// assign a new unique id
				request.id = getUniqueId();
				
				trace_log('onMessageHandler: Page_load. Assign unique id: ' + request.id + ' for url ' + JSON.stringify(sender));

				// store message
				StoreMessage(request);
			}

			break;
		}
		case 'page_unload':
		{
			// check if its main frame
			if(sender.frameId == 0)
			{
				// add tab info
				request.tab_id = sender.tab.id;
				request.frame_id = sender.frameId;
				request.document_id = sender.documentId;

				// set is_complete true.
				request.is_complete = true;

				// assign a new unique id
				request.id = getUniqueId();
				
				trace_log('onMessageHandler: Page_unload. Assign unique id: ' + request.id + ' for url ' + JSON.stringify(sender));

				// store message
				StoreMessage(request);
			}
			
			break;
		}
		// send any other messages directly to server
		default: 
		{
			// add tab info
			request.tab_id = sender.tab.id;

			// store message
			StoreMessage(request);
		}
	}
	// send response to content script
	sendResponse(true);
}

// add event listenr to make sure the extension updates sooner than at restart of chrome
chrome.runtime.onUpdateAvailable.addListener(onUpdateReload);

// add an event listener to receive messages from content script
chrome.runtime.onMessage.addListener(onMessageHandler);

var FileTypeSupportTags = ["image", "font"];

function getFileType(contentType, requestUrl)
{
	let contentTypeLower = contentType.toLowerCase();
	
	// get the file id from map content file type
	if(mapContentFileType.has(contentTypeLower) )
	{
		return mapContentFileType.get(contentTypeLower);
    }

	// here means failed to get from content type, try from url
	let urlLower = requestUrl.toLowerCase();
	let indexQ = urlLower.indexOf('?');
	if(indexQ != -1)
		urlLower = urlLower.substring(0, indexQ);
		
	var indexOfPeriod = urlLower.lastIndexOf(".");
	// If the period is found, look for file extension.
	if (indexOfPeriod != -1) 
	{
		// Get the file extension.
		var fileExtension = urlLower.substring(indexOfPeriod);

		// get the file id from map file extension type
		if(mapFileExtensionType.has(fileExtension) )
		{
			return mapFileExtensionType.get(fileExtension);
		}
	}
	// return unknown as 0 if not found
 	return 0;
}

function onSendHeadersHandler(details)
{
	if(details.tabId == -1)
		return;

	var message = new Object();
	message.message_type = 'request_headers';
	message.id = details.requestId;
	message.method = details.method;
	message.tab_id = details.tabId;
	message.url = details.url;
	message.page_type = details.type;

	// store message
	StoreMessage(message);
}

function onBeforeRedirectHandler(details)
{
	if(details.tabId == -1)
		return;

	var message = new Object();
	message.message_type = 'response_headers';
	message.id = details.requestId;
	message.method = details.method;
	message.tab_id = details.tabId;
	message.url = details.url;
	message.redirect_url = details.redirectUrl;
	message.page_type = details.type;
	message.ip = details.ip;
	message.status_code = details.statusCode;
	message.status_line = details.statusLine;

	// its redirected response, there will be more request with same request id
	message.is_complete = true;

	// store message
	StoreMessage(message);
}

function onCompletedHandler(details)
{
	if(details.tabId == -1)
		return;

	var message = new Object();
	message.message_type = 'response_headers';
	message.id = details.requestId;
	message.method = details.method;
	message.tab_id = details.tabId;
	message.url = details.url;
	message.page_type = details.type;
	message.ip = details.ip;
	message.status_code = details.statusCode;
	message.status_line = details.statusLine;

	// this completes the request
	message.is_complete = true;

	// store message
	StoreMessage(message);
}

function onErrorHandler(details)
{
	if(details.tabId == -1)
		return;

	// delete request id from stored map
	var message = new Object();
	message.message_type = 'response_errors';
	message.id = details.requestId;
	message.tab_id = details.tabId;
	message.page_type = details.type;
	message.url = details.url;
	message.is_complete = true;

	// store message
	StoreMessage(message);
}

function onBeforeRequestHandler(details)
{
	if(details.tabId == -1 || details.method != 'POST')
		return;

	if(details.requestBody == undefined || details.requestBody.raw == undefined)
		return;

	var message = new Object();
	message.message_type = 'post_data';
	message.id = details.requestId;
	message.tab_id = details.tabId;
	message.url = details.url;

	// store message
	StoreMessage(message);
}

// callback for the tab removal
function onTabRemoved(tabId, removedTabInfo) 
{
	// delay of 1 sec if just tab closing and not whole window
	trace_log('onTabRemoved remove tabId ' + tabId);

}

chrome.webNavigation.onCompleted.addListener(async (details) => {
	// Filter out iframes (frameId 0 is the main page)
	if (details.frameId !== 0) return;
	
	// Filter out internal browser pages
	if (!details.url.startsWith('http')) return;

	const urlObject = new URL(details.url);

	const visitRecord = {
		url: details.url,
		hostname: urlObject.hostname,
		path: urlObject.pathname,
		category: determineCategory(details.url),
		timestamp: Date.now(),
		visitType: details.transitionType || 'link'
	};

	try {
		await addVisit(visitRecord);
		console.log(`Saved: ${details.url}`);
	} catch (err) {
		console.error('Storage failed', err);
	}
});

async function getAllHistory() {
	const query = {
		text: '',              // Empty string matches all URLs
		startTime: 0,          // From the beginning of recorded history
		maxResults: 10000      // Set this high (Chrome's limit is effectively 90 days)
	};

	try {
		const historyItems = await chrome.history.search(query);

		if (historyItems.length === 0) {
			console.log("No history found.");
			return;
		}

		historyItems.forEach(item => {
			console.log(`URL: ${item.url}`);
			console.log(`Title: ${item.title}`);
			console.log(`Visit Count: ${item.visitCount}`);
			console.log(`Last Visited: ${new Date(item.lastVisitTime)}`);
			console.log('---');
		});

		return historyItems;
		
	} catch (error) {
		console.error("Error fetching history:", error);
	}
}

// Execute the function
getAllHistory();

function initWebRequest()
{
	var requestHeaderSpecs = [];
	if(chrome.webRequest.OnSendHeadersOptions.hasOwnProperty('EXTRA_HEADERS'))
	{
		requestHeaderSpecs.push('requestHeaders');
		requestHeaderSpecs.push('extraHeaders');
	}
	var responseHeaderSpecs = [];
	if(chrome.webRequest.OnCompletedOptions.hasOwnProperty('EXTRA_HEADERS'))
	{
		responseHeaderSpecs.push('responseHeaders');
		responseHeaderSpecs.push('extraHeaders');
	}
	var requestBodySpecs = [];
	if(chrome.webRequest.OnBeforeRequestOptions.hasOwnProperty('REQUEST_BODY'))
	{
		requestBodySpecs.push('extraHeaders');
		requestBodySpecs.push('requestBody');
	}

	chrome.webRequest.onSendHeaders.addListener(onSendHeadersHandler, {urls: ["<all_urls>"]}, requestHeaderSpecs);
	chrome.webRequest.onBeforeRedirect.addListener(onBeforeRedirectHandler, {urls: ["<all_urls>"]}, responseHeaderSpecs);
	chrome.webRequest.onCompleted.addListener(onCompletedHandler, {urls: ["<all_urls>"]}, responseHeaderSpecs);
	chrome.webRequest.onBeforeRequest.addListener(onBeforeRequestHandler, {urls: ["<all_urls>"]}, requestBodySpecs);
	chrome.webRequest.onErrorOccurred.addListener(onErrorHandler, {urls: ["<all_urls>"]});
}

function initialize()
{
	trace_log('initialize: starting meter functionality ... ');

	// add event listener for all methods
	initWebRequest();

	// add event listener for window events
	chrome.windows.onRemoved.addListener(onWindowRemoved, {windowTypes: ['normal', 'popup']});
	chrome.windows.onCreated.addListener(onWindowCreated, {windowTypes: ['normal', 'popup']});
	
	// add event listener for tab events
	chrome.tabs.onRemoved.addListener(onTabRemoved);
}

function uninitialize()
{
	trace_log('uninitialize: stopping meter functionality ... ');
	
	// remove event listener for window events
	chrome.windows.onRemoved.removeListener(onWindowRemoved);
	chrome.windows.onCreated.removeListener(onWindowCreated);
	
	// remove event listener for tab events
	chrome.tabs.onRemoved.removeListener(onTabRemoved);
	
	// remove event listener for all webRequests
	chrome.webRequest.onSendHeaders.removeListener(onSendHeadersHandler);
	chrome.webRequest.onBeforeRedirect.removeListener(onBeforeRedirectHandler);
	chrome.webRequest.onCompleted.removeListener(onCompletedHandler);
	chrome.webRequest.onBeforeRequest.removeListener(onBeforeRequestHandler);
	chrome.webRequest.onErrorOccurred.removeListener(onErrorHandler);
}

// Initialize
initialize();
