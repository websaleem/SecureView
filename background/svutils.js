// have all the utilities methods
var bLogEnabled = true;

// console enable to log
function trace_log(strLog, bError)
{
	if(bLogEnabled)
	{
		var day = new Date();
		console.log('%s.%d %s %s', day.toLocaleString(void 0, {hour12:!1}), day.getMilliseconds(), (bError ? 'error:' : 'info:'), strLog);
	}
}

// provides unique id
function getUniqueId()
{
	var time = new Date().getTime();
	var id = String(time % 100000) + String(Math.floor(Math.random() * Math.pow(7,3)).toPrecision(3)).replace(".","");
	
	return id;
}

// get provider name from host name
function getProviderName(url) 
{
	// get host name
	var hostName = new URL(url).hostname;

	// Remove the `www` prefix, if it exists.
	if (hostName.startsWith("www.")) {
		hostName = hostName.substring(4);
	}

	// Remove the `.com` suffix, if it exists.
	if (hostName.endsWith(".com")) {
		hostName = hostName.substring(0, hostName.length - 4);
	}

	// get the list by splitting using '.'
	let hostNameList = hostName.split('.');
	hostName = hostNameList[hostNameList.length - 1];

	return hostName;
}

// check if url belongs to https
function isSecure(url)
{
	return (url.toLowerCase().substring(0, 5) === 'https' ? true : false);
}

// determins the category of website
function determineCategory(url)
{
	// based on the url, find out the category
	return 'unknown';
}
