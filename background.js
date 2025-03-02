var trackedEvents = new Array();
var apiDomainDefault = 'api.segment.io,cdn.dreamdata.cloud,track.attributionapp.com,eu1.segmentapis.com,eu2.segmentapis.com,in.eu1.segmentapis.com,in.eu2.segmentapis.com,events.eu1.segmentapis.com,events.eu2.segmentapis.com';
var apiDomain = apiDomainDefault;

chrome.storage.local.get(['segment_api_domain'],(result) => {
	apiDomain = result.segment_api_domain || apiDomainDefault;
})

chrome.storage.onChanged.addListener((changes, namespace) => {
	if(namespace === 'local' && changes && changes.segment_api_domain) {
		apiDomain = changes.segment_api_domain.newValue || apiDomainDefault;
	}
});

function zeroPad(i) {
	if (i < 10) {
		i = "0" + i
	}
	return i;
}

function formatDateToTime(date) {
	return date.toLocaleTimeString()
}

function withOpenTab(callback) {
	chrome.tabs.query({
		active: true,
		currentWindow: true
	}, (tabs) => {
		var tab = tabs[0];

		if (tab) {
			callback(tab);
		}
	});
}

function addEvent(event) {
	trackedEvents.unshift(event);
	chrome.runtime.sendMessage({ type: "new_event" });
}

function updateTrackedEventsForTab(tabId,connection) {
	var sendEvents = [];

	for(var i=0;i<trackedEvents.length;i++) {
		if (trackedEvents[i].tabId == tabId) {
			sendEvents.push(trackedEvents[i]);
		}
	}

	connection.postMessage({
		type: 'update',
		events: sendEvents
	});
}

function clearTrackedEventsForTab(tabId,port) {
	var newTrackedEvents = [];
	for(var i=0;i<trackedEvents.length;i++) {
		if (trackedEvents[i].tabId != tabId) {
			newTrackedEvents.push(trackedEvents[i]);
		}
	}
	trackedEvents = newTrackedEvents;
}

chrome.runtime.onConnect.addListener((connection) => {
	var connectionHandler = (msg) => {
		var tabId = msg.tabId;
		if (msg.type == 'update') {
			updateTrackedEventsForTab(tabId, connection);
		}
		else if (msg.type == 'clear') {
			clearTrackedEventsForTab(tabId, connection);
			updateTrackedEventsForTab(tabId, connection);
		}
	};
	connection.onMessage.addListener(connectionHandler);
});

function isSegmentApiCall(url) {
	var apiDomainParts = apiDomain.split(',');
	return apiDomainParts.findIndex(d => url.startsWith(`https://${d.trim()}`)) != -1;
}

function onOwnServerResponse(url, callback) {
	withOpenTab((tab) => {
		try {
			if ((new URL(tab.url)).host === (new URL(url)).host) {
				callback();
			}
		}
		catch(exception) {
			console.log('Could not create URL.');
			console.log(exception);
		}
	})
}

function eventTypeToName(eventType) {
	switch(eventType) {
		case 'identify':
			return 'Identify'
		case 'pageLoad':
			return 'Page Loaded'
		case 'batch':
			return 'Batch'
	}
}

const onBeforeRequestHandler = (details) => {
	if (isSegmentApiCall(details.url)) {
		var bytes = new Uint8Array(details.requestBody.raw[0].bytes);
		var decoder = new TextDecoder('utf-8');
		var postedString = decoder.decode(bytes);

		var rawEvent = JSON.parse(postedString);

		var event = {
			raw: postedString,
			trackedTime: formatDateToTime(new Date()),
		};

		withOpenTab((tab) => {
			event.hostName = tab.url;
			event.tabId = tab.id;

			if (
				details.url.endsWith('/v1/t') ||
				details.url.endsWith('/v2/t') ||
				details.url.endsWith('/v1/track')
			) {
				event.type = 'track';
			}
			else if (
				details.url.endsWith('/v1/i') ||
				details.url.endsWith('/v2/i') ||
				details.url.endsWith('/v1/identify')
			) {
				event.type = 'identify';
			}
			else if (
				details.url.endsWith('/v1/p') ||
				details.url.endsWith('/v2/p') ||
				details.url.endsWith('/v1/page')
			) {
				event.type = 'pageLoad';
			}
			else if (
				details.url.endsWith('/v1/batch') ||
				details.url.endsWith('/v2/batch') ||
				details.url.endsWith('/v1/b') ||
				details.url.endsWith('/v2/b')
			) {
				event.type = 'batch';
			}

			if (event.type) {
				event.eventName = eventTypeToName(event.type) || rawEvent.event
				addEvent(event);
			}
		});
	}
};

chrome.webRequest.onBeforeRequest.addListener(
	(details) => {
		if (details.tabId > -1) {
			onBeforeRequestHandler(details);
		}
	},
	{
		urls: ['<all_urls>'],
	},
	["requestBody"]
);


const onHeadersReceivedHandler = (details) => {
	onOwnServerResponse(details.url, () => {
		const eventsHeader = details.responseHeaders.find(({ name }) => !!name && name.toLowerCase() === 'x-tracked-events');
		if (!eventsHeader) return

		withOpenTab((tab) => {
			const serverTrackedEvents = JSON.parse(eventsHeader.value);
			serverTrackedEvents.forEach((serverEvent) => {
				const event = {
					type: serverEvent.type,
					eventName: serverEvent.event || eventTypeToName(serverEvent.type),
					raw: JSON.stringify(serverEvent),
					trackedTime: formatDateToTime(new Date(serverEvent.timestamp)),
					hostName: details.url,
					tabId: tab.id
				};
				addEvent(event);
			})
		});
	})
};

chrome.webRequest.onHeadersReceived.addListener(
	(details) => {
		onHeadersReceivedHandler(details);
	},
	{
		urls: ['<all_urls>'],
	},
	['responseHeaders']
);