// --- Import biome collection from IBGE
var biomes = ee.FeatureCollection("projects/mapbiomas-workspace/AUXILIAR/biomas_IBGE_250mil");
 
// Define versions to process
var versions = [
    'c2-century_obs_09_25',   // Amazon
    'c2-century_pred_09_25',   // Caatinga, Pantanal, Cerrado
    // 'collection2_MODEL3_v2',   // Atlantic Forest, Pampa
];

// Load land use and land cover data
var lulc = ee.Image('projects/mapbiomas-public/assets/brazil/lulc/collection9/mapbiomas_collection90_integration_v1');
Map.addLayer(lulc, {
    bands: ['classification_2023'],
    min: 0,
    max: 69,
    palette: require('users/mapbiomas/modules:Palettes.js').get('classification9')
}, 'LULC History', false);

// Loop through each version
versions.forEach(function (VERSION) {
  // print('Starting processing for version:', VERSION);

  var MATRIX_ASSET_PATH = 'projects/cardosomvs/assets/diss/matriz-' + VERSION;
  var dataTraining = ee.FeatureCollection(MATRIX_ASSET_PATH);
  print('Training data loaded from:', MATRIX_ASSET_PATH);

  var dataTrainingColumns = dataTraining.first().propertyNames();

  var covariatesModule = require('users/wallacesilva/mapbiomas-solos:COLECAO_02/2024_c02betav2/module_covariates');  var staticCovariates = covariatesModule.static_covariates();
  var dynamicCovariates = covariatesModule.dynamic_covariates();

  var staticCovariateNames = staticCovariates.bandNames();
  var dynamicCovariateNames = dynamicCovariates.first().bandNames();

  var selectedStaticCovariates = staticCovariateNames.filter(ee.Filter.inList('item', dataTrainingColumns));
  var selectedDynamicCovariates = dynamicCovariateNames.filter(ee.Filter.inList('item', dataTrainingColumns));

  var covariateNames = selectedStaticCovariates.cat(selectedDynamicCovariates);
  print('Covariates loaded:', covariateNames);

  function decodeRandomForestAssetTable(featureCollection) {
    return featureCollection
      .map(function (feature) {
        var dictionary = feature.toDictionary();
        var keys = dictionary.keys().map(function (key) {
          return ee.Number.parse(ee.String(key));
        });
        var values = dictionary.values().sort(keys).join();
        return ee.Feature(null, { value: values });
      })
      .aggregate_array('value')
      .join()
      .decodeJSON();
  }

  var RANDOM_FOREST_MODEL_ASSET_PATH = 'projects/cardosomvs/assets/diss/rf-' + VERSION;
  var featureCollectionModelRandomForest = ee.FeatureCollection(RANDOM_FOREST_MODEL_ASSET_PATH);
  var randomForestModel = decodeRandomForestAssetTable(featureCollectionModelRandomForest);

  var aoi;
  if (VERSION === 'c2-century_obs_09_25') {
    aoi = biomes.filter(ee.Filter.eq('Bioma', 'Cerrado'));
  } else if (VERSION === 'c2-century_pred_09_25') {
    aoi = biomes.filter(ee.Filter.eq('Bioma', 'Cerrado'));
  }
  var aoiImg = ee.Image().paint(aoi, 1).selfMask();
  var aoiBounds = aoi.geometry().bounds();

  // var YEARS = ee.List.sequence(1985, 2023).getInfo();
  var YEARS = [
    1985,1986,1987,1988,1989,
    1990,1991,1992,1993,1994,
    1995,1996,1997,1998,1999,
    2000,2001,2002,2003,2004,
    2005,2006,2007,2008,2009,
    2010,2011,2012,2013,2014,
    2015,2016,2017,2018,2019,
    2020,2021,2022,
    2023
    ]
  var NUMBER_OF_TREES_RF = 399;
  var resultContainers = {
    median: ee.Image().select()
  };

  print('Starting temporal predictions for:', YEARS);

  function processYear(year) {
    print('Processing year:', year);

    var dynamicCovariatesYear = dynamicCovariates
      .select(selectedDynamicCovariates)
      .filter(ee.Filter.eq("year", year))
      .first();

    var covariatesImage = ee.Image()
      .select()
      .addBands(staticCovariates.select(selectedStaticCovariates))
      .addBands(dynamicCovariatesYear)
      .addBands(ee.Image.constant(year).int16().rename("year"))
      .updateMask(aoiImg);

    var bandName = "prediction_" + year;

    var containerTrees = ee.Image(
      ee.List.sequence(0, NUMBER_OF_TREES_RF).iterate(function (current, previous) {
        var treeClassifier = ee.Classifier.decisionTree(ee.List(randomForestModel).getString(ee.Number(current)));
        var img = covariatesImage
          .classify(treeClassifier)
          .rename(bandName)
          // .divide(100)
          .round()
          .int16();
        return ee.Image(previous).addBands(img);
      }, ee.Image().select())
    );

    // print('Prediction complete for', year);
    var lulcYear = lulc.select("classification_" + year);

    var where_landcover_carbon_zero = ee.Image()
      .blend(lulcYear.eq(23).selfMask())
      .blend(lulcYear.eq(24).selfMask())
      .blend(lulcYear.eq(30).selfMask())
      .multiply(0);
      // praias e dunas
      // area urbana
      // mineracao

    resultContainers.median = resultContainers.median.addBands(
      containerTrees.reduce("median").round().rename(bandName.replace("_", "_median_"))
      .where(where_landcover_carbon_zero.eq(0), 0)
    ).updateMask(aoiImg);

    // print('Added median result for', year);
  }

  YEARS.forEach(function (year) {
    processYear(year);
  });

  print('Completed all yearly predictions for version:', VERSION);

  var cloudSeriesFilter = function (image) {
    var filtered = ee.List(image.bandNames())
          .slice(1)
          .iterate(function (bandName, previousImage) {
                bandName = ee.String(bandName);
                var imageYear = ee.Image(image).select(bandName);
                previousImage = ee.Image(previousImage);

                var filtered = imageYear.where(
                    imageYear.eq(-2),
                    previousImage.slice(-1)
                );

                return previousImage.addBands(filtered);
          }, ee.Image(image.slice(0, 1)));

    image = ee.Image(filtered);

    var bandNames1 = ee.List(image.bandNames()).reverse();
    filtered = ee.List(bandNames1)
          .slice(1)
          .iterate(function (bandName, previousImage) {
                bandName = ee.String(bandName);
                var imageYear = ee.Image(image).select(bandName);
                previousImage = ee.Image(previousImage);

                var filtered = imageYear.where(
                    imageYear.eq(-2),
                    previousImage.slice(-1)
                );

                return previousImage.addBands(filtered);
          }, ee.Image(image.slice(-1)));

    image = ee.Image(filtered);

    return image.select(image.bandNames().sort());
};

  var waterBodies = ee.ImageCollection("projects/mapbiomas-workspace/AMOSTRAS/GTAGUA/OBJETOS/CLASSIFICADOS/TESTE_1_raster")
      .filter(ee.Filter.eq("version", "3"))
      .filter(ee.Filter.eq("year", 2023))
      .mosaic();

  var anthropizedBodies = waterBodies.neq(1);

  var submergedAreas = lulc.eq(33).or(lulc.eq(31)).reduce("sum").selfMask();

  submergedAreas = submergedAreas
      .gte(37)
      .where(anthropizedBodies.eq(1), 0)
      .multiply(-1)
      .int16();

  var maskAnthropizedBodies = lulc
      .eq(33)
      .or(lulc.eq(31))
      .where(anthropizedBodies.unmask().eq(0), 0)
      .eq(1);
      
  var maskRockOutcrop = lulc.eq(29);


  var palettes = require('users/wallacesilva/mapbiomas-solos:COLECAO_01/tools/module_palettes.js');

  var VIS_PARAMS = {
    median: { min: 0, max: 100, palette: palettes.get('stock_cos') },
  };

  var containerList = [
    {
      name: "median",
      image: resultContainers.median.int16(),
      visParams: VIS_PARAMS.median,
      export: true
    }
  ];

  containerList.forEach(function (item) {
    var name = item.name === "" ? "prediction_" : item.name;
    var bandName = "prediction_" + item.name + "_2023";
    var image = item.image;
    var visParams = item.visParams;
    var exportBoolean = item.export;

    var visualizationParams = {
      bands: [bandName],
      min: visParams.min,
      max: visParams.max,
      palette: visParams.palette
    };

    image = image
        .where(submergedAreas.eq(-1), -1)
        .where(maskAnthropizedBodies, -1)
        .where(maskRockOutcrop, -1)
        .updateMask(aoiImg);

    image = cloudSeriesFilter(image);
    image = image.updateMask(lulc.select(0).and(aoiImg));

    var mask = image.neq(-1).and(image.neq(-2));
    image = image.updateMask(mask);

    Map.addLayer(image, visualizationParams, VERSION + "_cos_t_ha_" + name, false);

    if (exportBoolean === true) {
      var outputPath = "projects/mapbiomas-workspace/SOLOS/PRODUTOS_C02/c02v2/tmp_carbon/supercartas_export_century_09_25";

      ee.ImageCollection(outputPath).size().evaluate(function (collectionSize) {
        if (collectionSize === undefined) {
          var newCollectionPath = outputPath;
          var assetType = 'ImageCollection';
          print('Please create an image collection at:', outputPath);
        }
      });

      print('image', image);

      var description = VERSION + "_SOC_tC_ha-000_030cm";

      exportPerSupercarta(image.set({
        bandName: bandName.slice(0, -4),
        'source': 'LABORATÓRIO DE PEDOMETRIA',
        version: VERSION,
        type: name,
      }), outputPath, description, aoi);
    }
  });
});

function exportPerSupercarta(image, output, description, filter_bounds) {
  var cartas = ee.FeatureCollection('projects/mapbiomas-workspace/AUXILIAR/cartas')
    .filterBounds(filter_bounds)
    .map(function (feature) {
      return feature.set({
        supercarta: feature.getString('grid_name').slice(0, -4)
      });
    });

  // var supercartas = cartas.aggregate_array('supercarta').distinct().sort().getInfo();
  cartas.aggregate_array('supercarta').distinct().sort().evaluate(function(supercartas){
    supercartas.forEach(function (supercarta) {
      var newDescription = description + '_' + supercarta;
      var supercartaFeature = cartas.filter(ee.Filter.eq('supercarta', supercarta));
      var geom = supercartaFeature.geometry();
  
      var imageToExport = image.clip(geom).set({
        carta: supercarta,
        name: newDescription,
        description: newDescription
      });
  
      Export.image.toAsset({
        image: imageToExport,
        description: 'GTSolo_' + newDescription,
        assetId: output + '/' + newDescription,
        pyramidingPolicy: "median",
        region: geom,
        scale: 30,
        maxPixels: 1e13
      });
  
      print('Task criada para:', newDescription);
    });
  });

}


// Crie uma lista de coordenadas [longitude, latitude] a partir dos seus dados
var pontos2 = [
    [-52.3021111, -15.8121944],
    [-52.17, -16.08275],
    [-46.6286, -8.1452],
    [-49.103, -12.0683],
    [-47.4318611, -6.6076944],
    [-50.4576389, -15.8956111],
    [-44.1949444, -6.6561111],
    [-48.4961, -9.0783],
    [-43.4954444, -6.5764167],
    [-47.5738333, -14.87575],
    [-52.2014444, -15.4480278],
    [-45.9349444, -7.2938889],
    [-52.3021111, -15.8121944],
    [-52.17, -16.08275],
    [-49.1575833, -14.3695],
    [-48.6989722, -15.7623056],
    [-47.3330556, -12.2306111],
    [-47.1751944, -17.26225],
    [-49.9731111, -17.02275],
    [-46.7369444, -14.8439722],
    [-49.2229722, -17.02275],
    [-46.7985833, -13.2243611],
    [-51.3979444, -15.9245833],
    [-50.33925, -13.7796111],
    [-50.4854444, -14.5268056],
    [-48.4553611, -7.8358056],
    [-49.0648333, -16.0191667],
    [-49.5004167, -15.4600556],
    [-51.2603333, -17.8170833],
    [-45.9633889, -12.8550556]
];

// Crie o objeto MultiPoint com os pontos
var pontos_geom = ee.Geometry.MultiPoint(pontos2);

// Defina as opções de visualização (cor e tamanho)
var visParam2s = {color: 'red', pointSize: 5};

// Adicione os pontos ao mapa com um nome de camada
Map.addLayer(pontos_geom, visParam2s, 'Pontos Inspecionados');

// Centralize o mapa nos pontos
Map.centerObject(pontos_geom, 5);

// --- Exportação dos dados dos pontos para CSV ---
// Essa função será chamada APÓS o loop forEach ser concluído.

    var yearlyPredictions = ee.ImageCollection([]); // <-- Aqui está o problema

yearlyPredictions.evaluate(function(collection) {
    var images = collection.features;
    images.forEach(function(image) {
        var year = ee.Number(image.properties.year).getInfo();
        var version = image.properties.version;
        
        // Extrai os valores de cada imagem para os pontos
        var extractedValues = ee.Image(image.id).reduceRegions({
            collection: ee.FeatureCollection(pontos_geom),
            reducer: ee.Reducer.mean(),
            scale: 30
        });

        // Exporta a tabela para o Google Drive
        Export.table.toDrive({
            collection: extractedValues,
            description: 'GTSolo_' + version + '_cos_t_ha_median_' + year,
            fileNamePrefix: 'GTSolo_' + version + '_cos_t_ha_median_' + year,
            fileFormat: 'CSV'
        });

        print('Tarefa de exportação criada para a versão:', version, 'e ano:', year);
    });
});
