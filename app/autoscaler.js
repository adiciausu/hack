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
	let objServerTypeRAMGBytes = {};

	console.log('Getting server types');
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

	let nRAMTotalB = null;
	let arrRAMUsedB = [];

	const nIntervalSecs = 1;
	const nProvisioningDurationSecs = 5 * 60;
	const nRAMTotalExpandFactor = 0.7;
	const nRAMTotalShrinkFactor = 0.7;
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

		if(
			objMetrics['storageTotals']['ram']['total'] === undefined
			|| objMetrics['storageTotals']['ram']['used'] === undefined
		)
		{
			sleep.sleep(2);
			continue;
		}

		nRAMTotalB = objMetrics['storageTotals']['ram']['total'];
		arrRAMUsedB.push([i++, objMetrics['storageTotals']['ram']['used']]);

		console.log("bProvisioning: " + bProvisioning);
		console.log("nRAMTotalB: " + nRAMTotalB);
		console.log("nRAMUsed: " + objMetrics['storageTotals']['ram']['used']);
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
			&& arrRAMUsedB.length >= nMinSampleSize
		)
		{
			const forecast = new Forecast();
			const nRAMUsedForecastB = forecast.forecast(
				arrRAMUsedB,
				nProvisioningDurationSecs / nIntervalSecs
			);

			console.log("nRAMForecasted: " + nRAMUsedForecastB);

			if(nRAMUsedForecastB >= nRAMTotalB * nRAMTotalExpandFactor)
			{
				const nRAMTotalGB = nRAMTotalB / 1024 / 1024 / 1024;
				const nRAMUsedForecastGB = nRAMUsedForecastB / 1024 / 1024 / 1204;
				let nRAMRequiredGB = nRAMUsedForecastGB - nRAMTotalGB * nRAMTotalExpandFactor;

				console.log("nRAMRequiredGB: " + nRAMRequiredGB);

				let objAvailableServerTypes = {};
				try
				{
					objAvailableServerTypes = await metalCloud.server_type_available_server_count_batch(
						objInfrastructure['user_id_owner'],
						objInfrastructure['datacenter_name'],
						Object.keys(objServerTypes),
						Math.ceil(nRAMRequiredGB / Math.min.apply(null, Object.values(objServerTypes)))
					);
				}
				catch(err)
				{
					console.log(err);
					sleep.sleep(1);
					continue;
				}

				console.log("objAvailableServerTypes: " + JSON.stringify(objAvailableServerTypes));

				const arrRAMSorted = Array.from(new Set(Object.values(objServerTypes))).sort(
					function (a, b)
					{
						return a - b;
					}
				);
				console.log('arrRAMSorted: ' + arrRAMSorted);

				let nInstancesToAdd = 0;
				let objServerTypesToProvision = {};

				for(let i = 0; i < arrRAMSorted.length; i++)
				{
					let ok = false;

					for(let j = 0; j < objServerTypeRAMGBytes[arrRAMSorted[i]].length; j++)
					{
						const nServerTypeID = objServerTypeRAMGBytes[arrRAMSorted[i]][j];
						console.log('nServerTypeID: ' + nServerTypeID);
						console.log('nRAM: ' + objServerTypes[nServerTypeID]);
						console.log('nAvailableServers: ' + objAvailableServerTypes[nServerTypeID]);
						if(objAvailableServerTypes[nServerTypeID] > 0)
						{

							const nNumberOfServers = Math.min.apply(
								null,
								[
									objAvailableServerTypes[nServerTypeID],
									Math.ceil(nRAMRequiredGB / objServerTypes[nServerTypeID])
								]
							);
							console.log('nNumberOfServers: ' + nNumberOfServers);
							objServerTypesToProvision[nServerTypeID] = nNumberOfServers;
							nInstancesToAdd += nNumberOfServers;
							nRAMRequiredGB -= nNumberOfServers * objServerTypes[nServerTypeID];
							if(nRAMRequiredGB <= 0)
							{
								ok = true;
								break;
							}
						}
					}

					if(ok)
					{
						break;
					}
				}

				console.log('objServerTypesToProvision: ' + JSON.stringify(objServerTypesToProvision));

				let objServerTypeMatches = {'server_types': {}};
				let arrBlaBla = Object.keys(objServerTypesToProvision);

				for(let i = 0; i < arrBlaBla.length; i++)
				{
					objServerTypeMatches['server_types'][arrBlaBla[i]] = {
						'server_count': objServerTypesToProvision[arrBlaBla[i]]
					};
				}

				arrBlaBla = Object.keys(objInstanceServerTypes);
				for(let i = 0; i < arrBlaBla.length; i++)
				{
					if(objServerTypeMatches['server_types'][arrBlaBla[i]] === undefined)
					{
						objServerTypeMatches['server_types'][arrBlaBla[i]] = {
							'server_count': 0
						};
					}
					objServerTypeMatches['server_types'][arrBlaBla[i]]['server_count'] += objInstanceServerTypes[arrBlaBla[i]];
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
			else if(nRAMUsedForecastB <= nRAMTotalB * nRAMTotalShrinkFactor)
			{
				const nRAMTotalGB = nRAMTotalB / 1024 / 1024 / 1024;
				const nRAMUsedForecastGB = nRAMUsedForecastB / 1024 / 1024 / 1204;
				let nRAMExcessGB = nRAMTotalGB * nRAMTotalExpandFactor - nRAMUsedForecastGB;

				/* Bug safety. */
				if(nRAMExcessGB >= nRAMTotalGB)
				{
					nRAMExcessGB = Math.max(
						nRAMTotalGB - 32,
						0
					);
				}

				console.log("nRAMExcessGB: " + nRAMExcessGB);

				const arrRAMSorted = Array.from(new Set(Object.values(objServerTypes))).sort(
					function (a, b)
					{
						return b - a;
					}
				);
				console.log('arrRAMSorted: ' + arrRAMSorted);

				let nInstancesToRemove = 0;
				let objServerTypeMatches = {'server_types': {}};
				let arrBlaBla = Object.keys(objInstanceServerTypes);

				for(let i = 0; i < arrBlaBla.length; i++)
				{
					if(objServerTypeMatches['server_types'][arrBlaBla[i]] === undefined)
					{
						objServerTypeMatches['server_types'][arrBlaBla[i]] = {
							'server_count': 0
						};
					}
					objServerTypeMatches['server_types'][arrBlaBla[i]]['server_count'] += objInstanceServerTypes[arrBlaBla[i]];
				}

				for(let i = 0; i < arrRAMSorted.length; i++)
				{
					let ok = false;

					for(let j = 0; j < objServerTypeRAMGBytes[arrRAMSorted[i]].length; j++)
					{
						const nServerTypeID = objServerTypeRAMGBytes[arrRAMSorted[i]][j];
						console.log('nServerTypeID: ' + nServerTypeID);
						console.log('nRAM: ' + objServerTypes[nServerTypeID]);
						console.log('nProvisionedServers: ' + objInstanceServerTypes[nServerTypeID]);
						if(
							objServerTypeMatches['server_types'][nServerTypeID] !== undefined
							&& objServerTypeMatches['server_types'][nServerTypeID]['server_count'] > 0
						)
						{
							const nNumberOfServers = Math.min.apply(
								null,
								[
									objInstanceServerTypes[nServerTypeID],
									Math.floor(nRAMExcessGB / objServerTypes[nServerTypeID])
								]
							);

							console.log('nNumberOfServers: ' + nNumberOfServers);
							objServerTypeMatches['server_types'][nServerTypeID]['server_count'] -= nNumberOfServers;
							nInstancesToRemove += nNumberOfServers;
							nRAMExcessGB -= nNumberOfServers * objServerTypes[nServerTypeID];
							if(nRAMExcessGB <= 0)
							{
								ok = true;
								break;
							}
						}
					}

					if(ok)
					{
						break;
					}
				}

				console.log('objServerTypeMatches: ' + JSON.stringify(objServerTypeMatches));

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
