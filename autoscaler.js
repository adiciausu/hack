const Process = require('process');
const Fetch = require('node-fetch');
const Couchbase = require('couchbase');
const MetalCloud = require("metal-cloud-sdk");
const JSONRPC = require("jsonrpc-bidirectional");


async function run()
{
	const objConfig = config();

	const metalCloud = await new MetalCloud.Clients.BSI(objConfig['strEndpointURL']);
	metalCloud.addPlugin(new JSONRPC.Plugins.Client.SignatureAdd(objConfig['strAPIKey']));

	const objCluster = await metalCloud.cluster_get(objConfig['nClusterID']);
	const objInfrastructure = await metalCloud.infrastructure_get(
		objCluster['infrastructure_id']
	);

	let objServerTypes = {};
	let objServerTypeRAMGBytes = {};
	const arrServerTypes = Object.values(await metalCloud.server_types(objInfrastructure['strDatacenter']));

	for(let i = 0; i < arrServerTypes.length; i++)
	{
		if(!objServerTypeRAMGBytes[arrServerTypes[i]['server_ram_gbytes']])
		{
			objServerTypeRAMGBytes[arrServerTypes[i]['server_ram_gbytes']] = [];
		}
		objServerTypeRAMGBytes[arrServerTypes[i]['server_ram_gbytes']].push(
			arrServerTypes[i]['server_type_id']
		);
		objServerTypes[arrServerTypes[i]['server_type_id']] = arrServerTypes[i]['server_ram_gbytes'];
	}

	let strUsername = null;
	let strPassword = null;

	let objInstanceArray = null;
	let objInstanceServerTypes = {};
	let arrInstanceLabels = Object.keys(objCluster['cluster_app']['nodes']);

	for(let i = 0; i < arrInstanceLabels.length; i++)
	{
		const objInstance = await metalCloud.instance_get(arrInstanceLabels[i]);
		objInstanceServerTypes[objInstance['server_type_id']] = arrInstanceLabels[i];

		if(objInstanceArray === null)
		{
			objInstanceArray = await metalCloud.instance_array_get(
				objInstance['instance_array_id']
			);
		}

		if(strUsername === null)
		{
			strUsername = objCluster['cluster_app']['nodes'][arrInstanceLabels[i]]['admin_username'];
			strPassword = objCluster['cluster_app']['nodes'][arrInstanceLabels[i]]['admin_initial_password'];
		}
	}

	const objMetrics = metrics(
		objInstanceArray['instance_array_subdomain'],
		8091, /* @TODO: Take it from the cluster_app. */
		strUsername,
		strPassword
	);
	console.log(objMetrics);
}

function config()
{
	if(!Process.env.AutoscalerMetalCloudEndpoint)
	{
		throw new Error(
			'The AutoscalerMetalCloudEndpoint environment variable must be set.'
		);
	}
	if(!Process.env.AutoscalerMetalCloudAPIKey)
	{
		throw new Error(
			'The AutoscalerMetalCloudAPIKey environment variable must be set.'
		);
	}
	if(!Process.env.AutoscalerClusterID)
	{
		throw new Error(
			'The AutoscalerClusterID environment variable must be set.'
		);
	}

	return {
		'strEndpointURL': Process.env.AutoscalerMetalCloudEndpoint,
		'strAPIKey': Process.env.AutoscalerMetalCloudAPIKey,
		'nClusterID': Process.env.AutoscalerClusterID
	};
}

function metrics(strAddress, nPort, strUsername, strPassword)
{
	var objMetrics = null;

	Fetch(
		'http://' + strUsername + ':' + strPassword + '@' + strAddress + ':' + nPort + '/pools/default'
	).then(function(res) {
		console.log(res.text());
		objMetrics = res.text();
	}).catch(function(err) {
		console.log(err)
	});

	return objMetrics;
}


try
{
	run();
}
catch(err)
{
	console.log(err);
}
