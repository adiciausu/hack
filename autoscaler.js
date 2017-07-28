const sleep = require('sleep');
const Process = require('process');
const Fetch = require('node-fetch');
const Couchbase = require('couchbase');
const Forecast = require("./forecast.js");
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

	let i = 0;

	let nRAMTotalB = null;
	let arrRAMUsedB = [];

	const nIntervalSecs = 5;
	const nProvisioningDurationSecs = 5 * 60;
	const nRAMTotalFactor = 0.7;
	const nMinSampleSize = 5;

	let bProvisioning = false;

	while(true)
	{
		const objMetrics = JSON.parse(await (await metrics(
			objInstanceArray['instance_array_subdomain'],
			8091, /* @TODO: Take it from the cluster_app. */
			strUsername,
			strPassword
		)).text());

		nRAMTotalB = objMetrics['storageTotals']['ram']['total'];
		arrRAMUsedB.push([i++, objMetrics['storageTotals']['ram']['used']]);

		console.log("nRAMTotalB: " + nRAMTotalB);
		console.log("nRAMUsed: " + objMetrics['storageTotals']['ram']['used']);
		console.log(arrRAMUsedB);

		if(
			!bProvisioning
			&& arrRAMUsedB.length >= nMinSampleSize
		)
		{
			const forecast = new Forecast();
			const nRAMUsedForecastB = forecast.forecast(
				arrRAMUsedB,
				nProvisioningDurationSecs / nIntervalSecs
			);

			console.log("nRAMForecasted: " + nRAMUsedForecastB);

			if(nRAMUsedForecastB >= nRAMTotalB * nRAMTotalFactor)
			{
				const nRAMTotalGB = nRAMTotalB / 1024 / 1024 / 1024;
				const nRAMUsedForecastGB = nRAMUsedForecastGB / 1024 / 1024 / 1204;
				const nRAMRequiredGB = nRAMUsedForecastGB - nRAMTotalGB * nRAMTotalFactor;

				console.log("nRAMRequiredGB: " + nRAMRequiredGB);

				const objAvailableServerTypes = {};
				while(true)
				{
					try
					{
						objAvailableServerTypes = await metalCloud.server_type_available_server_count_batch(
							objInfrastructure['user_id_owner'],
							objInfrastructure['datacenter_name'],
							Object.keys(objServerTypes),
							Math.ceil(nRAMRequiredGB / Math.min.apply(null, Object.keys(objServerTypeRAMGBytes)))
						);
						break;
					}
					catch(err)
					{
						console.log(err);
					}
				}

				console.log("objAvailableServerTypes: " + objAvailableServerTypes);

				bProvisioning = true;
			}
		}

		console.log("************************");

		sleep.sleep(nIntervalSecs);
	}

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
	if(!Process.env.AutoscalerUserID)
	{
		throw new Error(
			'The AutoscalerUserID environment variable must be set.'
		);
	}

	return {
		'strEndpointURL': Process.env.AutoscalerMetalCloudEndpoint,
		'strAPIKey': Process.env.AutoscalerMetalCloudAPIKey,
		'nClusterID': Process.env.AutoscalerClusterID,
		'nUserID': Process.env.AutoscalerUserID,
	};
}

async function metrics(strAddress, nPort, strUsername, strPassword)
{
	let objMetrics = null;

	try
	{
		objMetrics = await Fetch(
			'http://' + strUsername + ':' + strPassword + '@' + strAddress + ':' + nPort + '/pools/default'
		);
	}
	catch(err)
	{
		console.log('Error: ' + err);
	}

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
