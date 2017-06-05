<?php

class ScraperCommand
  extends AbstractFeedSyncCommand
{
  /** @var Scraper */
  private $activeScraper;

  /** @var Scrape */
  private $activeScrape;

  private $firebaseKey;

  public $verbose = false;

  public function actionScrape($id = null, $festivalId = null, $scrapeName = null, $force = false)
  {
    if ($id) {
      $scraper = Scraper::model()
        ->resetScope()
        ->findByPk($id);

    } else {
      if (is_string($scrapeName) && preg_match('#^\d+$#', $festivalId)) {
        $scraper = Scraper::model()
          ->resetScope()
          ->findByAttributes([
            'festivalId' => $festivalId,
            'name' => $scrapeName,
          ]);
      }
    }

    $startTime = time();
    if ($scraper) {
      $this->info("Scrape {$scrapeName} running at " . date("Y-m-d H:i:s"));
      $this->runScrape($scraper);
      $this->info("Scraper {$scraper->name} done at " . date("Y-m-d H:i:s") . ' (' . (time() - $startTime) . ' seconds)');
    } else {
      $this->error('Unknown Scraper: ' . ($scrapeName ?: $id));
    }
  }

  private function runScrape(Scraper $scraper)
  {
    $_GET['festivalId'] = $scraper->festivalId;

    if (!$scraper->type || !$scraper->festivalId) {
      $this->error("Invalid scape config {$scraper->name}");
      return;
    }

    if ($scraper->forced) {
      $scraper->forced = 0;
      $scraper->save();
    }

    $now = date('Y-m-d H:i:s');

    $scraper->error = null;
    $this->activeScraper = $scraper;
    $scrape = $this->recordStartOfScrape($scraper);
    $this->activeScrape = $scrape;
    $this->firebaseKey = strtotime($scrape->started) . '-' . $scrape->id;

    $this->pushScrapeToFirebase();

    $this->info("Scraping {$scraper->name} for {$scraper->type}");

    if ($this->runNewScraperMethod($scraper, $scrape)) return;

    $ucType = implode('', array_map('ucfirst', explode(' ', $scraper->type)));

    if (preg_match('#^dropbox (.*) photos$#', $scraper->type)) {
      $scrapeSource = new DropboxPhotosScrapeSource($scraper);
      $synchronizer = new DropboxPhotosSynchronizer($scraper, $scrapeSource);
    } elseif ($scraper->type === 'dropbox pages') {
      $scrapeSource = new DropboxPagesScrapeSource($scraper);
      $synchronizer = new MetaPageSynchronizer($scraper->festivalId, $scrapeSource,
        'common-dropbox-pages-' . $scraper->id);
    } elseif ($scraper->type === 'exhibitor login') {
      $scrapeSource = new ExhibitorLoginScrapeSource($scraper);
      $synchronizer = new MetaPageSynchronizer($scraper->festivalId, $scrapeSource, 'exhibitor-login-' . $scraper->id);
    } elseif (in_array($scraper->type, ['marcato artists', 'marcato venues'])) {
      $scraperName = preg_replace('#\s+#', '-', $scraper->type);
      $scrapeSource = new PageScrapeSource($scraperName, null, ['marcatoId' => $scraper->marcatoId]);
      $synchronizer = new MetaPageSynchronizer($scraper->festivalId, $scrapeSource, $scraperName . '-' . $scraper->id);
    } elseif (in_array($scraper->type, ['marcato workshops'])) {
      $scraperName = preg_replace('#\s+#', '-', $scraper->type);
      $scrapeSource = new EventScrapeSource($scraperName, null, ['marcatoId' => $scraper->marcatoId]);
      $synchronizer = new MetaEventSynchronizer($scraper->festivalId, $scrapeSource, $scraperName . '-' . $scraper->id);
    } elseif (in_array($scraper->type, ['marcato contacts'])) {
      $scraperName = preg_replace('#\s+#', '-', $scraper->type);
      $scrapeSource = new PageScrapeSource($scraperName, null, ['marcatoId' => $scraper->marcatoId]);
      $synchronizer = new MetaPageSynchronizer($scraper->festivalId, $scrapeSource, $scraperName . '-' . $scraper->id);
    } else {
      $metaClassName = "Meta{$ucType}Synchronizer";
      $scrapeSourceClassName = "{$ucType}ScrapeSource";
      $this->info($scrapeSourceClassName);
      $scrapeSource = new $scrapeSourceClassName($scraper->name);
      $synchronizer = new $metaClassName($scraper->festivalId, $scrapeSource, $scraper->name);
    }

    $watcher = new SynchronizerWatcher($synchronizer);
    try {
      $synchronizer->synchronize();
      $scrape->importResult($watcher);
      $scrape->finished = date('Y-m-d H:i:s');
      $scrape->save();

      $scraper->firstFailed = null;
      $scraper->latestFailed = null;
      $scraper->error = null;
      $scraper->save();

      $this->pushScrapeToFirebase();

      $this->recordFeedSyncSuccess($scraper->festivalId);

      $saved = $scraper->save();

      if (!$saved) {
        throw new CException('Unable to save scraper #' . $scraper->id . ': ' . var_export($scraper->errors, true));
      }

      $this->info('Running Image Uploader');
      $this->info(action('s3sync', 'syncDirectory', ['dirPath' => 'festival/' . $scraper->festivalId]));
    } catch (Exception $e) {
      if ($e->getMessage() === 'Scraper is disabled') {
        $scraper->error = 'scraper disabled on server';
        $this->info('Scraper is disabled on server');
      } elseif ($scraper->firstFailed == null) {
        $scraper->firstFailed = date('Y-m-d H:i:s');
        $scraper->latestFailed = date('Y-m-d H:i:s');
        $scraper->error = $e->getMessage() . "\n\n" . $e->getTraceAsString();
        $this->warning('Error Scraping ' . $e->getMessage() . ' ' . $e->getTraceAsString());
      } else {
        $scraper->latestFailed = date('Y-m-d H:i:s');

        $delta = min((time() - strtotime($scraper->firstFailed)) * 2, 7 * 24 * 36000);
        $scraper->nextScrape = date('Y-m-d H:i:s', time() + $delta);

        $this->warning('Error Scraping since ' . $scraper->firstFailed . ' ' . $e->getMessage() . "\n" . $e->getTraceAsString());
      }

      $scraper->save();

      $scrape->finished = date('Y-m-d H:i:s');
      $scrape->save();

      $this->pushScrapeToFirebase();
      throw $e;
    }

    $this->dumpScrapeResults($watcher->result);
  }

  private function pushScrapeToFirebase()
  {
    $scrape = $this->activeScrape;

    $obj = $scrape->attributes;
    unset($obj['id']);

    /** @var Festival $festival */
    $festival = Festival::model()
      ->findByPk($scrape->festivalId);
    $obj['festivalId'] = intval($obj['festivalId']);
    $obj['scraperId'] = intval($obj['scraperId']);
    $obj['festivalName'] = $festival->translate('title');
    $obj['error'] = !!$this->activeScraper->error;
    $obj['finished'] = strtotime($scrape->finished);
    $obj['started'] = strtotime($scrape->started);

    $colSum = 0;
    foreach (['created', 'updated', 'deleted', 'unchanged'] as $prop) {
      $colSum += intval($scrape->$prop);
    }
    if ($colSum === 0) {
      $obj['strange'] = 'Records processed is 0';
    }

    $nearestHour = strtotime(date('Y-m-d H:00:00'));
    Yii::app()->firebase->set("/scrapers/scrapes/$nearestHour/{$this->firebaseKey}", $obj);
  }

  private function dumpScrapeResults($result)
  {
    foreach ($result as $state => $records) {
      $count = is_array($records) ? count($records) : $records;
      $this->info("{$state}:{$count}");
    }
  }

  private function recordStartOfScrape($scraper)
  {
    $scrape = new Scrape();
    $scrape->scraperId = $scraper->id;
    $scrape->scrapeName = $scraper->name;
    $scrape->festivalId = $scraper->festivalId;
    $scrape->started = date('Y-m-d H:i:s');
    $scrape->save();

    return $scrape;
  }

  public function actionPending($realtime = false, $scheduled = false)
  {
    $type = $realtime ? 'realtime' : 'scheduled';

    $scrapers = Scraper::findPendingScrapers($type);
    foreach ($scrapers as $scraper) {
      println("{$scraper->id}");
    }
  }

  public function actionScrapeAll($sourceDomain = 'mea3.favequest.net')
  {
    $startTime = time();
    $this->info("Scrape All running at " . date("Y-m-d H:i:s"));


    $runningInstanceCount = intval(`ps -ef | grep -v grep | grep "scraper scrapeAll" | wc -l`) - 1;
    if ($runningInstanceCount > 1) {
      $this->info("Scrape All is already running", CLogger::LEVEL_INFO);

      return;
    }

    $this->actionUnlockFrozen();

    $scrapers = Scraper::findPendingScrapers();
    if (!$scrapers) {
      $this->info('No Scrapes Need Scraping');

      return;
    }

    foreach ($scrapers as $scraper) {
      try {
        $command = [
          Yii::app()->basePath,
          '/yiic scraper scrape --id=' . $scraper->id,
        ];

        $command = join('', $command);

        system($command . ' &');
      } catch (CException $ce) {
        $this->error('Unable to run scrape: ' . $scraper->name . '. Reason: ' . $ce->getMessage(), CLogger::LEVEL_WARNING);
      }
    }

    $this->info("Scrape All done at " . date("Y-m-d H:i:s") . ' (' . (time() - $startTime) . ' seconds)');
  }

  // Scrapers that have been running for more than twice their duration are considered failed
  public function actionUnlockFrozen()
  {
    $unfreezeCount = 0;

    /** @var Scrape $scrape */
    $runningScrapes = Scrape::model()
      ->resetScope(true)
      ->filterByCondition('started IS NOT NULL AND finished IS NULL')
      ->findAll();
    foreach ($runningScrapes as $scrape) {
      $scraper = Scraper::model()
        ->resetScope()
        ->findByPk($scrape->scraperId);
      if (!$scraper) {
        continue;
      }

      $frequency = $scraper->getFrequency();
      if ($frequency) {
        $duration = (time() - strtotime($scrape->started)) / 60;
        if ($duration > 2 * $frequency) {
          Yii::log("Unfreezing scrape {$scraper->name}: {$scrape->id}", CLogger::LEVEL_WARNING, 'scraper');
          Yii::log(var_export($scrape->attributes, true), CLogger::LEVEL_TRACE, 'scraper');
          $scraper->error = 'Frozen Scrape: ' . $scrape->id;
          $scraper->save();
          $unfreezeCount++;
        }
      }

      $scrape->finished = date('Y-m-d H:i:s');
      $scrape->save();
    }

    if (!$unfreezeCount) {
      Yii::log('No Scrapes were Frozen', CLogger::LEVEL_INFO, 'scraper');
    } else {
      Yii::log("{$unfreezeCount} scrapes unfrozen", CLogger::LEVEL_INFO, 'scraper');
    }

  }

  public function actionWipeOldScrapes()
  {
    $command = Yii::app()->db->createCommand('DELETE FROM tbl_scrape WHERE finished < :cutoff');
    $count = $command->execute([':cutoff' => date('Y-m-d H:i:s', time() - 24 * 60 * 60 * 7)]);
    $this->info("{$count} records deleted");
  }

  public function actionSyncPagePhotos($festivalId, $scraperName)
  {

  }

  private function info($msg)
  {
    Yii::log($msg, CLogger::LEVEL_INFO, 'scraper');
  }

  private function error($msg)
  {
    Yii::log($msg, CLogger::LEVEL_ERROR, 'scraper');
  }

  private function warning($msg)
  {
    Yii::log($msg, CLogger::LEVEL_WARNING, 'scraper');
  }

  /**
   * @param Scraper $scraper
   * @param $scrape
   */
  private function runNewScraperMethod(Scraper $scraper, $scrape)
  {
    $scraperRunner = new ScraperRunner();
    $result = $scraperRunner->run($scraper);
    // If supported by new system
    if ($result !== false) {
      foreach ($result as $prop => $value) {
        $scrape->$prop = $value;
      }
      $scrape->finished = date('Y-m-d H:i:s');
      $scrape->save();
      $this->pushScrapeToFirebase();
      $this->dumpScrapeResults($result);

      $this->info('Running Image Uploader');
      $this->info(action('s3sync', 'syncDirectory', ['dirPath' => 'festival/' . $scraper->festivalId]));
      return true;
    }
  }
}

