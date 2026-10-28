package ru.priceaggregator;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(PageReaderPlugin.class);
    super.onCreate(savedInstanceState);
  }
}