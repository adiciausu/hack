const Math = require('mathjs');
const sleep = require('sleep');
const Process = require('process');
const Fetch = require('node-fetch');
const Forecast = require("./forecast.js");
const MetalCloud = require("metal-cloud-sdk");
const JSONRPC = require("jsonrpc-bidirectional");


async function run()
{
	const objConfig = config();

	const metalCloud = await new MetalCloud.Clients.BSI(objConfig['strEndpointURL']);
	metalCloud.addPlugin(new JSONRPC.Plugins.Client.SignatureAdd(objConfig['strAPIKey']));

	console.log('Getting cluster');
	let objCluster = await metalCloud.cluster_get(objConfig['nClusterID']);

	console.log('Getting infrastructure');
	let objInfrastructure = await metalCloud.infrastructure_get(
		objCluster['infrastructure_id']
	);

	let objServerTypes = {};
	let objServerTypeCoreCount = {};

	console.log('Getting server types');
	const arrServerTypes = Object.values(await metalCloud.server_types(objInfrastructure['strDatacenter']));

	for(let i = 0; i < arrServerTypes.length; i++)
	{
		if(!objServerTypeCoreCount[arrServerTypes[i]['server_processor_core_count']])
		{
			objServerTypeCoreCount[arrServerTypes[i]['server_processor_core_count']] = [];
		}
		objServerTypeCoreCount[arrServerTypes[i]['server_processor_core_count']].push(
			arrServerTypes[i]['server_type_id']
		);
		objServerTypes[arrServerTypes[i]['server_type_id']] = arrServerTypes[i]['server_processor_core_count'];
	}

	let strUsername = null;
	let strPassword = null;

	let objInstanceArray = null;
	let objInstanceServerTypes = {};
	let arrInstanceLabels = Object.keys(objCluster['cluster_app']['nodes']).sort();
	const strFirstInstanceLabel = arrInstanceLabels[0];

	for(let i = 0; i < arrInstanceLabels.length; i++)
	{
		const objInstance = await metalCloud.instance_get(arrInstanceLabels[i]);
		if(objInstanceServerTypes[objInstance['server_type_id']] === undefined)
		{
			objInstanceServerTypes[objInstance['server_type_id']] = 0;
		}
		objInstanceServerTypes[objInstance['server_type_id']] += 1;

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

	let nCPULoadMax = 100;
	let arrCPULoadAverage = [];

	const nIntervalSecs = 1;
	const nProvisioningDurationSecs = 5 * 60;
	const nCPUMaxExpandFactor = 0.5;
	const nCPUMaxShrinkFactor = 0.2;
	const nMinSampleSize = 5;

	let bProvisioning = objInfrastructure['infrastructure_operation']['infrastructure_deploy_status'] === 'ongoing';

	while(true)
	{
		let objMetrics = null;
		try
		{
			console.log('Getting metrics');
			objMetrics = JSON.parse(await (await metrics(
				objInstanceArray['instance_array_subdomain'],
				8091, /* @TODO: Take it from the cluster_app. */
				strUsername,
				strPassword
			)).text());
		}
		catch(err)
		{
			sleep.sleep(2);
			continue;
		}

		if(objMetrics['nodes'] === undefined)
		{
			sleep.sleep(2);
			continue;
		}

		let nCPULoadAverage = 0;
		for(let i = 0; i < objMetrics['nodes'].length; i++)
		{
			nCPULoadAverage += objMetrics['nodes'][i]['systemStats']['cpu_utilization_rate'];
		}

		nCPULoadAverage /= objMetrics['nodes'].length;

		arrCPULoadAverage.push([i++, nCPULoadAverage]);

		console.log("bProvisioning: " + bProvisioning);
		console.log("nCPULoadMax: " + nCPULoadMax);
		console.log("nCPULoadAverage: " + nCPULoadAverage);
		console.log("objInstanceServerTypes: " + JSON.stringify(objInstanceServerTypes));

		if(bProvisioning)
		{
			objInfrastructure = await metalCloud.infrastructure_get(objInfrastructure['infrastructure_id']);
			if(objInfrastructure['infrastructure_operation']['infrastructure_deploy_status'] === 'finished')
			{
				objInstanceArray = null;
				objInstanceServerTypes = {};

				objCluster = await metalCloud.cluster_get(objConfig['nClusterID']);
				arrInstanceLabels = Object.keys(objCluster['cluster_app']['nodes']);

				for(let i = 0; i < arrInstanceLabels.length; i++)
				{
					const objInstance = await metalCloud.instance_get(arrInstanceLabels[i]);
					if(objInstanceServerTypes[objInstance['server_type_id']] === undefined)
					{
						objInstanceServerTypes[objInstance['server_type_id']] = 0;
					}
					objInstanceServerTypes[objInstance['server_type_id']] += 1;

					if(objInstanceArray === null)
					{
						objInstanceArray = await metalCloud.instance_array_get(
							objInstance['instance_array_id']
						);
					}
				}

				bProvisioning = false;
			}
		}

		if(
			!bProvisioning
			&& arrCPULoadAverage.length >= nMinSampleSize
		)
		{
			const forecast = new Forecast();
			const nCPULoadForecast = forecast.forecast(
				arrCPULoadAverage,
				nProvisioningDurationSecs / nIntervalSecs
			);

			console.log("nCPULoadForecast: " + nCPULoadForecast);

			if(nCPULoadForecast >= nCPULoadMax * nCPUMaxExpandFactor)
			{
				console.log('Expanding');
				console.log('nCPULoadForecast ' + nCPULoadForecast);
				console.log('nCPULoadMax * nCPUMaxExpandFactor ' + (nCPULoadMax * nCPUMaxExpandFactor));

				let objAvailableServerTypes = {};
				try
				{
					objAvailableServerTypes = await metalCloud.server_type_available_server_count_batch(
						objInfrastructure['user_id_owner'],
						objInfrastructure['datacenter_name'],
						Object.keys(objServerTypes),
						100
					);
				}
				catch(err)
				{
					console.log(err);
					sleep.sleep(1);
					continue;
				}

				console.log("objAvailableServerTypes: " + JSON.stringify(objAvailableServerTypes));

				const arrCPUCoreCountSorted = Array.from(new Set(Object.values(objServerTypes))).sort(
					function (a, b)
					{
						return b - a;
					}
				);
				console.log('arrCPUCoreCountSorted: ' + arrCPUCoreCountSorted);

				let nInstancesToAdd = 0;
				let objServerTypesToProvision = {};

				for(let i = 0; i < arrCPUCoreCountSorted.length; i++)
				{
					let ok = false;

					for(let j = 0; j < objServerTypeCoreCount[arrCPUCoreCountSorted[i]].length; j++)
					{
						const nServerTypeID = objServerTypeCoreCount[arrCPUCoreCountSorted[i]][j];
						console.log('nServerTypeID: ' + nServerTypeID);
						console.log('nRAM: ' + objServerTypes[nServerTypeID]);
						console.log('nAvailableServers: ' + objAvailableServerTypes[nServerTypeID]);
						if(objAvailableServerTypes[nServerTypeID] > 0)
						{
							nInstancesToAdd = 1;
							objServerTypesToProvision[nServerTypeID] = 1;
							ok = true;
							break;
						}
					}

					if(ok)
					{
						break;
					}
				}

				console.log('objServerTypesToProvision: ' + JSON.stringify(objServerTypesToProvision));

				let objServerTypeMatches = {'server_types': {}};
				let arrServerTypesAux = Object.keys(objServerTypesToProvision);

				for(let i = 0; i < arrServerTypesAux.length; i++)
				{
					objServerTypeMatches['server_types'][arrServerTypesAux[i]] = {
						'server_count': objServerTypesToProvision[arrServerTypesAux[i]]
					};
				}

				arrServerTypesAux = Object.keys(objInstanceServerTypes);
				for(let i = 0; i < arrServerTypesAux.length; i++)
				{
					if(objServerTypeMatches['server_types'][arrServerTypesAux[i]] === undefined)
					{
						objServerTypeMatches['server_types'][arrServerTypesAux[i]] = {
							'server_count': 0
						};
					}
					objServerTypeMatches['server_types'][arrServerTypesAux[i]]['server_count'] += objInstanceServerTypes[arrServerTypesAux[i]];
				}

				console.log('objServerTypeMatches: ' + JSON.stringify(objServerTypeMatches));

				objInstanceArrayNew = await metalCloud.instance_array_edit(
					objInstanceArray['instance_array_id'],
					{
						'instance_array_id': objInstanceArray['instance_array_id'],
						'instance_array_change_id': objInstanceArray['instance_array_operation']['instance_array_change_id'],
						'instance_array_label': objInstanceArray['instance_array_operation']['instance_array_label'],
						'instance_array_instance_count': objInstanceArray['instance_array_operation']['instance_array_instance_count'] + nInstancesToAdd
					},
					false,
					true,
					objServerTypeMatches
				);

				console.log('objInstanceArray: ' + JSON.stringify(objInstanceArray));

				await metalCloud.infrastructure_deploy(objInfrastructure['infrastructure_id']);

				bProvisioning = true;
			}
			else if(nCPULoadForecast <= nCPULoadMax * nCPUMaxShrinkFactor)
			{
				console.log('Shrinking');

				const arrCPUCoreCountSorted = Array.from(new Set(Object.values(objServerTypes))).sort(
					function (a, b)
					{
						return a - b;
					}
				);
				console.log('arrCPUCoreCountSorted: ' + arrCPUCoreCountSorted);

				let nInstancesToRemove = 0;
				let objServerTypeMatches = {'server_types': {}};
				let arrServerTypesAux = Object.keys(objInstanceServerTypes);

				for(let i = 0; i < arrServerTypesAux.length; i++)
				{
					if(objServerTypeMatches['server_types'][arrServerTypesAux[i]] === undefined)
					{
						objServerTypeMatches['server_types'][arrServerTypesAux[i]] = {
							'server_count': 0
						};
					}
					objServerTypeMatches['server_types'][arrServerTypesAux[i]]['server_count'] += objInstanceServerTypes[arrServerTypesAux[i]];
				}

				for(let i = 0; i < arrCPUCoreCountSorted.length; i++)
				{
					let ok = false;

					for(let j = 0; j < objServerTypeCoreCount[arrCPUCoreCountSorted[i]].length; j++)
					{
						const nServerTypeID = objServerTypeCoreCount[arrCPUCoreCountSorted[i]][j];
						console.log('nServerTypeID: ' + nServerTypeID);
						console.log('nRAM: ' + objServerTypes[nServerTypeID]);
						console.log('nProvisionedServers: ' + objInstanceServerTypes[nServerTypeID]);
						if(
							objServerTypeMatches['server_types'][nServerTypeID] !== undefined
							&& objServerTypeMatches['server_types'][nServerTypeID]['server_count'] > 0
						)
						{
							nInstancesToRemove = 1;
							objServerTypeMatches['server_types'][nServerTypeID]['server_count'] -= 1;

							ok = true;
							break;
						}
					}

					if(ok)
					{
						break;
					}
				}

				console.log('objServerTypeMatches: ' + JSON.stringify(objServerTypeMatches));

				if(objInstanceArray['instance_array_operation']['instance_array_instance_count'] - nInstancesToRemove > 0)
				{
					objInstanceArrayNew = await metalCloud.instance_array_edit(
						objInstanceArray['instance_array_id'],
						{
							'instance_array_id': objInstanceArray['instance_array_id'],
							'instance_array_change_id': objInstanceArray['instance_array_operation']['instance_array_change_id'],
							'instance_array_label': objInstanceArray['instance_array_operation']['instance_array_label'],
							'instance_array_instance_count': objInstanceArray['instance_array_operation']['instance_array_instance_count'] - nInstancesToRemove
						},
						false,
						true,
						objServerTypeMatches
					);

					await metalCloud.infrastructure_deploy(objInfrastructure['infrastructure_id']);

					bProvisioning = true;
				}
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
